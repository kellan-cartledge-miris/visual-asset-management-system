#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
"""The gate and every release site derive the claim key here, so they cannot drift apart."""
import io
import json
from unittest.mock import MagicMock

import pytest

import mirisClaim


class _Logger:
    def info(self, *a, **k):
        pass

    def warning(self, *a, **k):
        pass


# The workflow supplies `auxBucket + pipelines/{pipelineName}/{executionId}/`.
EXEC_A = "s3://vams-aux-bucket/pipelines/miris-upload/exec-1111/"
EXEC_B = "s3://vams-aux-bucket/pipelines/miris-upload/exec-2222/"


def test_key_is_bucket_root_scoped_and_execution_independent():
    assert mirisClaim.claim_location(EXEC_A, "a1", "v7") == (
        "vams-aux-bucket", "locks/miris-upload/a1/v7.claim")
    assert mirisClaim.claim_location(EXEC_B, "a1", "v7") == (
        "vams-aux-bucket", "locks/miris-upload/a1/v7.claim")


def test_bare_bucket_uri_is_accepted():
    assert mirisClaim.claim_location("s3://vams-aux-bucket", "a1", "v7") == (
        "vams-aux-bucket", "locks/miris-upload/a1/v7.claim")


def test_blank_version_falls_back_to_live():
    assert mirisClaim.claim_location(EXEC_A, "a1", "")[1] == "locks/miris-upload/a1/live.claim"


@pytest.mark.parametrize("aux,asset", [("", "a1"), (EXEC_A, ""), ("", "")])
def test_missing_inputs_yield_no_location(aux, asset):
    assert mirisClaim.claim_location(aux, asset, "v7") == (None, None)


def _held_by(token):
    s3 = MagicMock()
    s3.get_object.side_effect = lambda **_: {
        "Body": io.BytesIO(json.dumps({"owner": mirisClaim.owner_id(token)}).encode())}
    return s3


def test_release_deletes_the_claim_this_execution_holds():
    s3 = _held_by("tok-a")
    assert mirisClaim.release_claim(
        s3, _Logger(), EXEC_A, "a1", "v7", mirisClaim.owner_id("tok-a")) is True
    s3.delete_object.assert_called_once_with(
        Bucket="vams-aux-bucket", Key="locks/miris-upload/a1/v7.claim")


def test_release_without_a_location_is_a_no_op():
    s3 = MagicMock()
    assert mirisClaim.release_claim(s3, _Logger(), "", "a1", "v7", "owner") is False
    s3.delete_object.assert_not_called()


def test_release_swallows_delete_errors():
    s3 = _held_by("tok-a")
    s3.delete_object.side_effect = Exception("AccessDenied")
    assert mirisClaim.release_claim(
        s3, _Logger(), EXEC_A, "a1", "v7", mirisClaim.owner_id("tok-a")) is False


def test_release_leaves_a_claim_held_by_another_execution():
    s3 = _held_by("tok-b")
    assert mirisClaim.release_claim(
        s3, _Logger(), EXEC_A, "a1", "v7", mirisClaim.owner_id("tok-a")) is False
    s3.delete_object.assert_not_called()


@pytest.mark.parametrize("body", [b"not json", b"[]"])
def test_release_leaves_an_unreadable_claim(body):
    s3 = MagicMock()
    s3.get_object.side_effect = lambda **_: {"Body": io.BytesIO(body)}
    assert mirisClaim.release_claim(s3, _Logger(), EXEC_A, "a1", "v7", "") is False
    s3.delete_object.assert_not_called()


def test_owner_id_is_a_digest_and_empty_without_a_token():
    assert mirisClaim.owner_id("") == ""
    assert len(mirisClaim.owner_id("tok-a")) == 64
    assert "tok-a" not in mirisClaim.owner_id("tok-a")
