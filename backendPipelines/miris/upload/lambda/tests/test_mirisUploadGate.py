#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
import json
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def gate():
    import importlib
    import mirisUploadGate
    return importlib.reload(mirisUploadGate)


def _event(**overrides):
    body = {
        "databaseId": "db1",
        "assetId": "a1",
        "assetVersionId": "v7",
        "inputOutputS3AssetAuxiliaryFilesPath": "s3://aux/a1",
        "sfnExternalTaskToken": "tok-1",
    }
    body.update(overrides)
    return {"body": json.dumps(body)}


def test_first_claim_proceeds(gate):
    with patch.object(gate, "s3_client") as s3:
        result = gate.lambda_handler(_event(), None)

    assert result["gate"] == "proceed"
    assert s3.put_object.call_args.kwargs["IfNoneMatch"] == "*"
    assert s3.put_object.call_args.kwargs["Key"].endswith("a1/v7.claim")


def test_second_claim_skips_and_reports_success(gate):
    error = gate.s3_client.exceptions.ClientError(
        {"Error": {"Code": "PreconditionFailed"}}, "PutObject")
    with patch.object(gate, "s3_client") as s3, patch.object(gate, "sfn_client") as sfn:
        s3.exceptions.ClientError = type(error)
        s3.put_object.side_effect = error
        result = gate.lambda_handler(_event(), None)

    assert result["gate"] == "skip"
    sfn.send_task_success.assert_called_once()
    output = json.loads(sfn.send_task_success.call_args.kwargs["output"])
    assert output["status"] == "skipped"


def test_missing_version_falls_back_to_live(gate):
    with patch.object(gate, "s3_client") as s3:
        gate.lambda_handler(_event(assetVersionId=""), None)

    assert s3.put_object.call_args.kwargs["Key"].endswith("a1/live.claim")


def test_no_aux_path_proceeds_rather_than_blocking(gate):
    with patch.object(gate, "s3_client") as s3:
        result = gate.lambda_handler(
            _event(inputOutputS3AssetAuxiliaryFilesPath=""), None)

    assert result["gate"] == "proceed"
    s3.put_object.assert_not_called()
