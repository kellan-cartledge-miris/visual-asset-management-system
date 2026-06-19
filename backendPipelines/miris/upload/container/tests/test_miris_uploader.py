#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
import json
import os
import sys

import pytest
import responses

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

BASE = "https://api.miris.test"
KEY = "test-integration-key-xxx"
UUID = "11111111-2222-3333-4444-555555555555"


@responses.activate
def test_start_upload_posts_correct_body_and_returns_response():
    from miris_uploader import MirisClient

    responses.add(
        responses.POST,
        f"{BASE}/v1/asset",
        json={
            "id": UUID,
            "endpoint_type": "s3",
            "endpoint_url": "https://s3.us-west-1.amazonaws.com",
            "region": "us-west-1",
            "access_key_id": "AK",
            "secret_key": "SK",
            "session_token": "ST",
            "upload_path": "s3://miris-uploads-bucket/ws/up",
            "total_bytes": 1024,
            "file_count": 1,
        },
        status=200,
    )

    client = MirisClient(BASE, KEY)
    resp = client.start_upload(
        name="model",
        content_path="model.usdz",
        total_bytes=1024,
        tags=["vams"],
    )
    sent = json.loads(responses.calls[0].request.body)
    assert sent == {
        "name": "model",
        "content_path": "model.usdz",
        "file_count": 1,
        "input_type": "usd",
        "output_type": "static",
        "tags": ["vams"],
        "total_bytes": 1024,
    }
    auth_header = responses.calls[0].request.headers["Authorization"]
    assert auth_header == f"Bearer {KEY}"
    assert resp["id"] == UUID


@responses.activate
def test_mark_upload_complete_puts_status_completed():
    from miris_uploader import MirisClient

    responses.add(
        responses.PUT,
        f"{BASE}/v1/asset/upload/{UUID}",
        json={"id": UUID, "upload_status": "completed"},
        status=200,
    )

    client = MirisClient(BASE, KEY)
    client.mark_upload_complete(UUID)
    sent = json.loads(responses.calls[0].request.body)
    assert sent == {"status": "completed"}


@responses.activate
def test_trigger_generate_posts_no_body():
    from miris_uploader import MirisClient

    responses.add(
        responses.POST,
        f"{BASE}/v1/asset/{UUID}/generate",
        json={"asset_id": UUID, "job_id": "job1", "state": "processing_streamable"},
        status=200,
    )

    client = MirisClient(BASE, KEY)
    result = client.trigger_generate(UUID)
    assert result["state"] == "processing_streamable"
    # The POST body is empty
    body = responses.calls[0].request.body
    assert body in (None, b"", "")


@responses.activate
def test_poll_until_streamable_breaks_on_ready_state():
    from miris_uploader import MirisClient

    # Two "processing" responses then a "streamable_ready"
    for state in ("processing_streamable", "processing_streamable"):
        responses.add(
            responses.GET,
            f"{BASE}/v1/asset/{UUID}",
            json={"id": UUID, "state": state},
            status=200,
        )
    responses.add(
        responses.GET,
        f"{BASE}/v1/asset/{UUID}",
        json={"id": UUID, "state": "streamable_ready"},
        status=200,
    )

    client = MirisClient(BASE, KEY)
    result = client.poll_until_streamable(
        UUID, timeout_seconds=10, poll_interval_seconds=0
    )
    assert result["state"] == "streamable_ready"
    assert len(responses.calls) == 3


@responses.activate
def test_poll_until_streamable_times_out():
    from miris_uploader import MirisClient

    responses.add(
        responses.GET,
        f"{BASE}/v1/asset/{UUID}",
        json={"id": UUID, "state": "processing_streamable"},
        status=200,
    )

    client = MirisClient(BASE, KEY)
    with pytest.raises(TimeoutError):
        client.poll_until_streamable(
            UUID, timeout_seconds=0, poll_interval_seconds=0
        )


def test_redact_response_masks_secret_triple():
    from miris_uploader import _redact_response

    redacted = _redact_response(
        {
            "id": "x",
            "access_key_id": "AK",
            "secret_key": "SK",
            "session_token": "ST",
            "endpoint_url": "https://example.com",
        }
    )
    assert redacted["id"] == "x"
    assert redacted["endpoint_url"] == "https://example.com"
    assert redacted["access_key_id"] == "<redacted>"
    assert redacted["secret_key"] == "<redacted>"
    assert redacted["session_token"] == "<redacted>"


def test_redact_response_is_pure():
    """Does not mutate the input."""
    from miris_uploader import _redact_response

    original = {"secret_key": "SK"}
    _redact_response(original)
    assert original == {"secret_key": "SK"}
