#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
import json
import os
from unittest.mock import patch

import pytest

# This module's boto3 clients are constructed at import time from AWS_REGION. Set it
# defensively so this test file does not depend on the ambient shell environment.
os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")


@pytest.fixture
def open_pipeline(monkeypatch):
    monkeypatch.setenv("STATE_MACHINE_ARN", "arn:aws:states:us-east-1:123456789012:stateMachine:x")
    monkeypatch.setenv("ALLOWED_INPUT_FILEEXTENSIONS", ".usd")
    monkeypatch.setenv("ORCHESTRATION_BUS_NAME", "")
    monkeypatch.setenv("STATE_MACHINE_LOG_GROUP_NAME", "")
    monkeypatch.setenv("STATE_MACHINE_LOG_GROUP_ARN", "")
    import importlib
    import openMirisUploadPipeline
    return importlib.reload(openMirisUploadPipeline)


def test_no_bus_name_skips_registration(open_pipeline):
    with patch.object(open_pipeline, "events_client") as ev:
        open_pipeline.register_sub_execution(
            "", "vams.prod.execution.exec1.pipeline.pe1", "exec-arn", "sm-arn")

    ev.put_events.assert_not_called()


def test_no_event_prefix_skips_registration(open_pipeline):
    with patch.object(open_pipeline, "events_client") as ev:
        open_pipeline.register_sub_execution("my-bus", "", "exec-arn", "sm-arn")

    ev.put_events.assert_not_called()


def test_unrecognized_event_prefix_skips_registration(open_pipeline):
    # No ".pipeline." marker, so manifestHelper.pipeline_execution_id_from_event_prefix
    # (real, unmocked) returns "" and registration must not proceed.
    with patch.object(open_pipeline, "events_client") as ev:
        open_pipeline.register_sub_execution(
            "my-bus", "vams.prod.execution.exec1", "exec-arn", "sm-arn")

    ev.put_events.assert_not_called()


def test_happy_path_registers_sub_execution(open_pipeline):
    with patch.object(open_pipeline, "events_client") as ev:
        open_pipeline.register_sub_execution(
            "my-bus", "vams.prod.execution.exec1.pipeline.pe1",
            "arn:aws:states:us-east-1:123456789012:execution:x:y", "sm-arn")

    ev.put_events.assert_called_once()
    entry = ev.put_events.call_args.kwargs["Entries"][0]
    assert entry["EventBusName"] == "my-bus"
    assert entry["Source"] == "vams.prod.execution.exec1.pipeline.pe1"
    assert entry["DetailType"] == "pipeline.execution.register"

    detail = json.loads(entry["Detail"])
    assert detail["pipelineExecutionId"] == "pe1"
    assert detail["subExecution"]["stateMachineArn"] == "sm-arn"
    assert detail["subExecution"]["executionArn"] == (
        "arn:aws:states:us-east-1:123456789012:execution:x:y")


def test_log_group_env_vars_populate_logs_field(open_pipeline, monkeypatch):
    monkeypatch.setattr(open_pipeline, "STATE_MACHINE_LOG_GROUP_NAME",
                         "/aws/vendedlogs/VAMSstateMachine-MirisUpload")
    monkeypatch.setattr(open_pipeline, "STATE_MACHINE_LOG_GROUP_ARN",
                         "arn:aws:logs:us-east-1:123456789012:log-group:"
                         "/aws/vendedlogs/VAMSstateMachine-MirisUpload")

    with patch.object(open_pipeline, "events_client") as ev:
        open_pipeline.register_sub_execution(
            "my-bus", "vams.prod.execution.exec1.pipeline.pe1", "exec-arn", "sm-arn")

    detail = json.loads(ev.put_events.call_args.kwargs["Entries"][0]["Detail"])
    assert detail["logs"] == [{
        "logGroupArn": "arn:aws:logs:us-east-1:123456789012:log-group:"
                       "/aws/vendedlogs/VAMSstateMachine-MirisUpload",
        "logGroupName": "/aws/vendedlogs/VAMSstateMachine-MirisUpload",
        "logStreamName": "",
    }]


def test_log_group_env_vars_absent_omits_logs_field(open_pipeline):
    # Fixture leaves both log-group env vars as "", the fixture's default.
    with patch.object(open_pipeline, "events_client") as ev:
        open_pipeline.register_sub_execution(
            "my-bus", "vams.prod.execution.exec1.pipeline.pe1", "exec-arn", "sm-arn")

    detail = json.loads(ev.put_events.call_args.kwargs["Entries"][0]["Detail"])
    assert "logs" not in detail


def test_put_events_failure_is_swallowed(open_pipeline):
    with patch.object(open_pipeline, "events_client") as ev:
        ev.put_events.side_effect = Exception("EventBridge unavailable")
        # Must not raise: registration is best-effort and must never fail the pipeline.
        open_pipeline.register_sub_execution(
            "my-bus", "vams.prod.execution.exec1.pipeline.pe1", "exec-arn", "sm-arn")


AUX = "s3://vams-aux-bucket/pipelines/miris-upload/exec-aaaa1111/"


def _execute_event(**overrides):
    event = {
        "inputS3AssetFilePath": "s3://assets/a1/model.usd",
        "inputOutputS3AssetAuxiliaryFilesPath": AUX,
        "assetId": "a1",
        "assetVersionId": "v7",
        "databaseId": "db1",
        "sfnExternalTaskToken": "tok-1",
    }
    event.update(overrides)
    return event


def test_rejected_extension_releases_the_claim(open_pipeline):
    with patch.object(open_pipeline, "sfn") as sfn, \
         patch.object(open_pipeline, "s3_client") as s3:
        resp = open_pipeline.lambda_handler(
            _execute_event(inputS3AssetFilePath="s3://assets/a1/model.obj"), None)

    assert resp["statusCode"] == 400
    sfn.send_task_failure.assert_called_once()
    s3.delete_object.assert_called_once_with(
        Bucket="vams-aux-bucket", Key="locks/miris-upload/a1/v7.claim")


def test_folder_input_releases_the_claim(open_pipeline):
    with patch.object(open_pipeline, "sfn"), patch.object(open_pipeline, "s3_client") as s3:
        resp = open_pipeline.lambda_handler(
            _execute_event(inputS3AssetFilePath="s3://assets/a1/"), None)

    assert resp["statusCode"] == 400
    s3.delete_object.assert_called_once()


def test_start_execution_failure_releases_the_claim(open_pipeline):
    with patch.object(open_pipeline, "sfn") as sfn, \
         patch.object(open_pipeline, "s3_client") as s3:
        sfn.start_execution.side_effect = Exception("state machine unavailable")
        resp = open_pipeline.lambda_handler(_execute_event(), None)

    assert resp["statusCode"] == 500
    s3.delete_object.assert_called_once()


def test_started_execution_keeps_the_claim_and_forwards_the_version(open_pipeline):
    import datetime

    with patch.object(open_pipeline, "sfn") as sfn, \
         patch.object(open_pipeline, "s3_client") as s3:
        sfn.start_execution.return_value = {
            "executionArn": "arn:aws:states:us-east-1:123456789012:execution:x:y",
            "startDate": datetime.datetime(2026, 8, 14),
        }
        resp = open_pipeline.lambda_handler(_execute_event(), None)

    assert resp["statusCode"] == 200
    s3.delete_object.assert_not_called()
    sfn_input = json.loads(sfn.start_execution.call_args.kwargs["input"])
    assert sfn_input["assetVersionId"] == "v7"
    assert sfn_input["inputOutputS3AssetAuxiliaryFilesPath"] == AUX
