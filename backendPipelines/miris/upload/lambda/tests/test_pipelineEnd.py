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

AUX = "s3://vams-aux-bucket/pipelines/miris-upload/exec-aaaa1111/"


@pytest.fixture
def end():
    import importlib
    import pipelineEnd
    return importlib.reload(pipelineEnd)


def _event(**overrides):
    event = {
        "externalSfnTaskToken": "tok-1",
        "status": "success",
        "assetId": "a1",
        "assetVersionId": "v7",
        "inputOutputS3AssetAuxiliaryFilesPath": AUX,
    }
    event.update(overrides)
    return event


def test_success_reports_task_success_and_keeps_the_claim(end):
    with patch.object(end, "sfn") as sfn, patch.object(end, "s3_client") as s3:
        end.lambda_handler(_event(mirisAssetUuid="uuid-1"), None)

    output = json.loads(sfn.send_task_success.call_args.kwargs["output"])
    assert output["mirisAssetUuid"] == "uuid-1"
    # The claim is what collapses the trigger fan-out; a successful run must not remove it.
    s3.delete_object.assert_not_called()


def test_failure_reports_task_failure_and_releases_the_claim(end):
    with patch.object(end, "sfn") as sfn, patch.object(end, "s3_client") as s3:
        end.lambda_handler(_event(status="failed", cause="Batch job exited 1"), None)

    sfn.send_task_success.assert_not_called()
    assert sfn.send_task_failure.call_args.kwargs["taskToken"] == "tok-1"
    assert sfn.send_task_failure.call_args.kwargs["cause"] == "Batch job exited 1"
    s3.delete_object.assert_called_once_with(
        Bucket="vams-aux-bucket", Key="locks/miris-upload/a1/v7.claim")


def test_failure_releases_the_claim_even_without_a_token(end):
    with patch.object(end, "sfn") as sfn, patch.object(end, "s3_client") as s3:
        end.lambda_handler(_event(status="failed", externalSfnTaskToken=""), None)

    sfn.send_task_failure.assert_not_called()
    s3.delete_object.assert_called_once()


def test_failure_cause_is_truncated(end):
    with patch.object(end, "sfn") as sfn, patch.object(end, "s3_client"):
        end.lambda_handler(_event(status="failed", cause="x" * 5000), None)

    assert len(sfn.send_task_failure.call_args.kwargs["cause"]) == 256


def test_release_failure_does_not_mask_the_pipeline_failure(end):
    with patch.object(end, "sfn") as sfn, patch.object(end, "s3_client") as s3:
        s3.delete_object.side_effect = Exception("AccessDenied")
        result = end.lambda_handler(_event(status="failed"), None)

    assert result["statusCode"] == 200
    sfn.send_task_failure.assert_called_once()
