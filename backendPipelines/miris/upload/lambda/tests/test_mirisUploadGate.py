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
def gate():
    import importlib
    import mirisUploadGate
    return importlib.reload(mirisUploadGate)


# The real workflow passes `auxBucket + auxTempPrefix`, where the temp prefix is
# `pipelines/{pipelineName}/{executionId}/` -- unique per execution. The fixture mirrors that
# shape so a key derivation that folded the prefix in would be visible here.
def _aux_path(execution_id="exec-aaaa1111"):
    return f"s3://vams-aux-bucket/pipelines/miris-upload/{execution_id}/"


def _event(**overrides):
    body = {
        "databaseId": "db1",
        "assetId": "a1",
        "assetVersionId": "v7",
        "inputOutputS3AssetAuxiliaryFilesPath": _aux_path(),
        "sfnExternalTaskToken": "tok-1",
    }
    body.update(overrides)
    return {"body": json.dumps(body)}


def test_first_claim_proceeds(gate):
    with patch.object(gate, "s3_client") as s3:
        result = gate.lambda_handler(_event(), None)

    assert result["gate"] == "proceed"
    assert s3.put_object.call_args.kwargs["IfNoneMatch"] == "*"
    assert s3.put_object.call_args.kwargs["Bucket"] == "vams-aux-bucket"
    assert s3.put_object.call_args.kwargs["Key"] == "locks/miris-upload/a1/v7.claim"


def test_claim_key_ignores_the_execution_scoped_aux_prefix(gate):
    """The regression guard for the dedup itself.

    The auxiliary path is scoped to the workflow execution, so each fanned-out execution receives a
    different one. If any part of that prefix reached the claim key, every conditional put would
    succeed and nothing would ever be deduplicated.
    """
    with patch.object(gate, "s3_client") as s3:
        gate.lambda_handler(_event(inputOutputS3AssetAuxiliaryFilesPath=_aux_path("exec-1111")), None)
        first = s3.put_object.call_args.kwargs

        gate.lambda_handler(_event(inputOutputS3AssetAuxiliaryFilesPath=_aux_path("exec-2222")), None)
        second = s3.put_object.call_args.kwargs

    assert first["Bucket"] == second["Bucket"] == "vams-aux-bucket"
    assert first["Key"] == second["Key"] == "locks/miris-upload/a1/v7.claim"


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

    assert s3.put_object.call_args.kwargs["Key"] == "locks/miris-upload/a1/live.claim"


def test_no_aux_path_proceeds_rather_than_blocking(gate):
    with patch.object(gate, "s3_client") as s3:
        result = gate.lambda_handler(
            _event(inputOutputS3AssetAuxiliaryFilesPath=""), None)

    assert result["gate"] == "proceed"
    s3.put_object.assert_not_called()
