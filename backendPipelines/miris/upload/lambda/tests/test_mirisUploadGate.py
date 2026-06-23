#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0

import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# Make the lambda directory importable in tests
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv(
        "MIRIS_UPLOAD_ENABLED_DATABASES",
        json.dumps(["db-allowed-1", "db-allowed-2"]),
    )


def _event(databaseId, manual=False, task_token="tt-test"):
    body = {
        "databaseId": databaseId,
        "assetId": "asset-1",
        "inputS3AssetFilePath": "s3://bucket/asset-1/model.usdz",
        "sfnExternalTaskToken": task_token,
        "inputParameters": json.dumps({"manual": True}) if manual else "",
    }
    return {"body": json.dumps(body)}


def test_manual_invocation_bypasses_allow_list():
    """When inputParameters.manual is true, gate proceeds regardless of database."""
    with patch("mirisUploadGate.boto3") as mock_boto3:
        import mirisUploadGate
        result = mirisUploadGate.lambda_handler(
            _event("db-NOT-in-list", manual=True), None
        )
    assert result["gate"] == "proceed"
    mock_boto3.client.return_value.send_task_success.assert_not_called()


def test_database_in_allow_list_proceeds():
    """Database present in MIRIS_UPLOAD_ENABLED_DATABASES proceeds."""
    with patch("mirisUploadGate.boto3") as mock_boto3:
        import mirisUploadGate
        result = mirisUploadGate.lambda_handler(_event("db-allowed-1"), None)
    assert result["gate"] == "proceed"
    mock_boto3.client.return_value.send_task_success.assert_not_called()


def test_database_not_in_allow_list_skips_and_sends_task_success():
    """Database NOT in allow-list short-circuits to skip + sfn send_task_success."""
    with patch("mirisUploadGate.boto3") as mock_boto3:
        import mirisUploadGate
        result = mirisUploadGate.lambda_handler(_event("db-blocked"), None)
    assert result["gate"] == "skip"
    mock_boto3.client.return_value.send_task_success.assert_called_once()
    call_kwargs = mock_boto3.client.return_value.send_task_success.call_args.kwargs
    assert call_kwargs["taskToken"] == "tt-test"
    output = json.loads(call_kwargs["output"])
    assert output["status"] == "skipped"
    assert "db-blocked" in output["reason"]


def test_empty_allow_list_skips_all_non_manual(monkeypatch):
    """Empty allow-list = no auto-upload fires."""
    monkeypatch.setenv("MIRIS_UPLOAD_ENABLED_DATABASES", "[]")
    with patch("mirisUploadGate.boto3") as mock_boto3:
        import mirisUploadGate
        result = mirisUploadGate.lambda_handler(_event("db-anything"), None)
    assert result["gate"] == "skip"


def test_missing_task_token_proceeds_anyway():
    """If no TaskToken, we still proceed/skip but don't try to call send_task_success."""
    with patch("mirisUploadGate.boto3") as mock_boto3:
        import mirisUploadGate
        result = mirisUploadGate.lambda_handler(
            _event("db-blocked", task_token=""), None
        )
    assert result["gate"] == "skip"
    mock_boto3.client.return_value.send_task_success.assert_not_called()
