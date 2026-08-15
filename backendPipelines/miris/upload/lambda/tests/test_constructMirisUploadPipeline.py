#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
import json
import os
import pytest

# This module's boto3 clients are constructed at import time from AWS_REGION. Set it
# defensively so this test file does not depend on the ambient shell environment.
os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")


@pytest.fixture
def construct(monkeypatch):
    monkeypatch.setenv("MIRIS_API_BASE_URL", "https://api.example.test")
    monkeypatch.setenv("MIRIS_API_KEY_SECRET_ARN", "arn:aws:secretsmanager:::secret:x")
    import importlib
    import constructMirisUploadPipeline
    return importlib.reload(constructMirisUploadPipeline)


def _event(**overrides):
    event = {
        "jobName": "job-1",
        "inputS3AssetFilePath": "s3://assets/a1/sub/model.usd",
        "inputOutputS3AssetAuxiliaryFilesPath": "s3://aux/a1",
        "outputS3AssetFilesPath": "s3://assets/a1/",
        "inputConfigurationS3Location": "s3://assets/cfg.json",
        "assetId": "a1",
        "databaseId": "db1",
        "mirisAssetName": "Pump Housing",
    }
    event.update(overrides)
    return event


def test_definition_carries_config_location_and_asset_name(construct):
    result = construct.lambda_handler(_event(), None)
    stage = json.loads(result["definition"][0])["stages"][0]

    assert stage["mirisAssetName"] == "Pump Housing"
    assert stage["inputConfigurationS3Location"] == "s3://assets/cfg.json"
    assert stage["assetId"] == "a1"


def test_input_parameters_are_gone(construct):
    result = construct.lambda_handler(_event(), None)
    definition = json.loads(result["definition"][0])

    assert "inputParameters" not in definition
    assert "inputParameters" not in result


def test_no_duplicate_short_circuit_remains(construct):
    # Dedup moved to the gate's atomic claim; construct must never report DUPLICATE_DETECTED.
    first = construct.lambda_handler(_event(), None)
    second = construct.lambda_handler(_event(), None)

    assert first["status"] == "STARTING"
    assert second["status"] == "STARTING"


def test_claim_fields_are_carried_to_the_failure_branch(construct):
    # The state machine's failure branch reads these JSONPaths off the construct result.
    result = construct.lambda_handler(_event(assetVersionId="v7"), None)

    assert result["assetId"] == "a1"
    assert result["assetVersionId"] == "v7"
    assert result["inputOutputS3AssetAuxiliaryFilesPath"] == "s3://aux/a1"


def test_claim_fields_are_present_when_the_version_is_unknown(construct):
    result = construct.lambda_handler(_event(), None)

    assert result["assetVersionId"] == ""
