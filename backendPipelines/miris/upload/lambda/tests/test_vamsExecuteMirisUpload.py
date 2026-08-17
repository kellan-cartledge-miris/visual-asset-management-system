#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
import json
import os
from unittest.mock import MagicMock, patch

import pytest

# This module's boto3 clients are constructed at import time from AWS_REGION. Set it
# defensively so this test file does not depend on the ambient shell environment.
os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")


@pytest.fixture
def handler(monkeypatch):
    monkeypatch.setenv("OPEN_PIPELINE_FUNCTION_NAME", "open-fn")
    monkeypatch.setenv("MIRIS_UPLOAD_GATE_FUNCTION_NAME", "gate-fn")
    monkeypatch.setenv("ASSET_STORAGE_TABLE_NAME", "asset-table")
    import importlib
    import vamsExecuteMirisUpload
    return importlib.reload(vamsExecuteMirisUpload)


def test_missing_task_token_reports_nothing_and_500s(handler):
    # No token to report against, so the handler must not raise on the way out.
    resp = handler.lambda_handler({"body": json.dumps({"assetId": "a1"})}, None)
    assert resp["statusCode"] == 500


def test_manifest_failure_sends_task_failure(handler):
    with patch.object(handler, "sfn_client") as sfn, \
         patch.object(handler.manifestHelper, "resolve_pipeline_inputs",
                      side_effect=Exception("manifest unreadable")):
        resp = handler.lambda_handler(
            {"body": json.dumps({"TaskToken": "tok-1"})}, None)

    assert resp["statusCode"] == 500
    sfn.send_task_failure.assert_called_once()
    assert sfn.send_task_failure.call_args.kwargs["taskToken"] == "tok-1"


def test_resolves_asset_name_and_version_from_dynamodb(handler):
    resolved = {
        "assetId": "a1", "databaseId": "db1", "inputFiles": [{"assetId": "a1"}],
        "inputS3AssetFilePath": "s3://b/a1/model.usd",
        "outputS3AssetFilesPath": "s3://b/a1/",
        "outputS3AssetPreviewPath": "", "outputS3AssetMetadataPath": "",
        "inputOutputS3AssetAuxiliaryFilesPath": "s3://aux/a1",
        "inputMetadataS3Location": "", "inputConfigurationS3Location": "s3://b/cfg.json",
        "orchestrationEventPrefix": "", "manifestUsed": True,
    }
    table = MagicMock()
    table.get_item.return_value = {
        "Item": {"assetName": "Pump Housing", "currentVersionId": "v7"}}

    with patch.object(handler.manifestHelper, "resolve_pipeline_inputs", return_value=resolved), \
         patch.object(handler, "_asset_table", return_value=table), \
         patch.object(handler, "lambda_client") as lc:
        lc.invoke.return_value = {
            "StatusCode": 200,
            "Payload": MagicMock(read=lambda: json.dumps({"gate": "proceed"}).encode()),
        }
        resp = handler.lambda_handler({"body": json.dumps({"TaskToken": "tok-1"})}, None)

    assert resp["statusCode"] == 200
    gate_payload = json.loads(lc.invoke.call_args_list[0].kwargs["Payload"].decode())
    gate_body = json.loads(gate_payload["body"])
    assert gate_body["assetVersionId"] == "v7"
    assert gate_body["mirisAssetName"] == "Pump Housing"


def test_gate_skip_short_circuits(handler):
    resolved = {k: "" for k in (
        "assetId", "databaseId", "inputS3AssetFilePath", "outputS3AssetFilesPath",
        "outputS3AssetPreviewPath", "outputS3AssetMetadataPath",
        "inputOutputS3AssetAuxiliaryFilesPath", "inputMetadataS3Location",
        "inputConfigurationS3Location", "orchestrationEventPrefix")}
    resolved["inputFiles"] = []
    table = MagicMock()
    table.get_item.return_value = {"Item": {}}

    with patch.object(handler.manifestHelper, "resolve_pipeline_inputs", return_value=resolved), \
         patch.object(handler, "_asset_table", return_value=table), \
         patch.object(handler, "lambda_client") as lc:
        lc.invoke.return_value = {
            "StatusCode": 200,
            "Payload": MagicMock(read=lambda: json.dumps({"gate": "skip"}).encode()),
        }
        resp = handler.lambda_handler({"body": json.dumps({"TaskToken": "tok-1"})}, None)

    assert resp["statusCode"] == 200
    # Only the gate was invoked — openPipeline must not run.
    assert lc.invoke.call_count == 1


def _resolved(**overrides):
    resolved = {
        "assetId": "a1",
        "databaseId": "db1",
        "inputS3AssetFilePath": "s3://b/a1/model.usd",
        "outputS3AssetFilesPath": "s3://b/a1/",
        "outputS3AssetPreviewPath": "",
        "outputS3AssetMetadataPath": "",
        "inputOutputS3AssetAuxiliaryFilesPath":
            "s3://vams-aux-bucket/pipelines/miris-upload/exec-aaaa1111/",
        "inputMetadataS3Location": "",
        "inputConfigurationS3Location": "s3://b/cfg.json",
        "orchestrationEventPrefix": "",
        "inputFiles": [{"assetId": "a1"}],
        "manifestUsed": True,
    }
    resolved.update(overrides)
    return resolved


def _asset_table_mock(asset_name="Pump Housing", version="v7"):
    table = MagicMock()
    table.get_item.return_value = {
        "Item": {"assetName": asset_name, "currentVersionId": version}}
    return table


def test_asset_version_is_carried_into_the_pipeline_payload(handler):
    """openPipeline (and everything downstream) needs the version to release the claim."""
    with patch.object(handler.manifestHelper, "resolve_pipeline_inputs",
                      return_value=_resolved()), \
         patch.object(handler, "_asset_table", return_value=_asset_table_mock()), \
         patch.object(handler, "lambda_client") as lc:
        lc.invoke.return_value = {
            "StatusCode": 200,
            "Payload": MagicMock(read=lambda: json.dumps({"gate": "proceed"}).encode()),
        }
        handler.lambda_handler({"body": json.dumps({"TaskToken": "tok-1"})}, None)

    open_payload = json.loads(lc.invoke.call_args_list[1].kwargs["Payload"].decode())
    assert open_payload["assetVersionId"] == "v7"


def test_failure_after_claim_releases_it(handler):
    with patch.object(handler.manifestHelper, "resolve_pipeline_inputs",
                      return_value=_resolved()), \
         patch.object(handler, "_asset_table", return_value=_asset_table_mock()), \
         patch.object(handler, "s3_client") as s3, \
         patch.object(handler, "sfn_client"), \
         patch.object(handler, "lambda_client") as lc:
        lc.invoke.side_effect = [
            {"StatusCode": 200,
             "Payload": MagicMock(read=lambda: json.dumps({"gate": "proceed"}).encode())},
            Exception("openPipeline unreachable"),
        ]
        resp = handler.lambda_handler({"body": json.dumps({"TaskToken": "tok-1"})}, None)

    assert resp["statusCode"] == 500
    s3.delete_object.assert_called_once_with(
        Bucket="vams-aux-bucket", Key="locks/miris-upload/a1/v7.claim")


def test_failure_before_the_gate_releases_nothing(handler):
    with patch.object(handler.manifestHelper, "resolve_pipeline_inputs",
                      side_effect=Exception("manifest unreadable")), \
         patch.object(handler, "s3_client") as s3, \
         patch.object(handler, "sfn_client"):
        handler.lambda_handler({"body": json.dumps({"TaskToken": "tok-1"})}, None)

    s3.delete_object.assert_not_called()


def test_gate_skip_does_not_release_the_winning_claim(handler):
    with patch.object(handler.manifestHelper, "resolve_pipeline_inputs",
                      return_value=_resolved()), \
         patch.object(handler, "_asset_table", return_value=_asset_table_mock()), \
         patch.object(handler, "s3_client") as s3, \
         patch.object(handler, "lambda_client") as lc:
        lc.invoke.return_value = {
            "StatusCode": 200,
            "Payload": MagicMock(read=lambda: json.dumps({"gate": "skip"}).encode()),
        }
        handler.lambda_handler({"body": json.dumps({"TaskToken": "tok-1"})}, None)

    s3.delete_object.assert_not_called()
