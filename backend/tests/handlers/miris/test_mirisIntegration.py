# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""The shared Miris Integration API client: request shape, status handling, Integration Key
caching and rotation, and that no key or response body reaches a log line or exception message."""

import logging
from datetime import datetime, timedelta, timezone

import pytest
import requests

from backend.backend.handlers.miris import mirisIntegration
from backend.backend.handlers.miris.mirisIntegration import MirisIntegrationError

KEY_ID = "3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b"
RESPONSE_BODY = "miris-response-body-must-not-surface"


class TestDeleteViewerKeyRequest:
    def test_sends_one_delete_with_the_integration_key_header_and_a_timeout(self, miris_api):
        miris_api.responses.append(204)

        mirisIntegration.delete_viewer_key(KEY_ID)

        assert len(miris_api.calls) == 1
        call = miris_api.calls[0]
        assert call["method"] == "DELETE"
        assert call["url"] == f"{miris_api.base_url}/v1/asset-viewer-key/{KEY_ID}"
        assert call["headers"]["Miris-API-Key"] == miris_api.integration_key
        assert call["timeout"] == mirisIntegration._REQUEST_TIMEOUT_SECONDS
        assert call["timeout"] is not None
        miris_api.secretsmanager.get_secret_value.assert_called_once_with(SecretId=miris_api.secret_arn)

    @pytest.mark.parametrize("status", [200, 204, 404])
    def test_success_statuses_return_without_raising(self, miris_api, status):
        miris_api.responses.append(status)
        assert mirisIntegration.delete_viewer_key(KEY_ID) is None

    @pytest.mark.parametrize("status", [400, 409, 429, 500, 502, 503])
    def test_other_statuses_raise_with_the_status_code_only(self, miris_api, status):
        miris_api.responses.append((status, RESPONSE_BODY))

        with pytest.raises(MirisIntegrationError) as raised:
            mirisIntegration.delete_viewer_key(KEY_ID)

        assert raised.value.status_code == status
        assert str(status) in str(raised.value)
        assert RESPONSE_BODY not in str(raised.value)
        assert miris_api.integration_key not in str(raised.value)

    def test_transport_failure_raises_without_the_key_or_url_detail(self, miris_api):
        miris_api.responses.append(
            requests.ConnectionError(f"boom {miris_api.integration_key} {RESPONSE_BODY}")
        )

        with pytest.raises(MirisIntegrationError) as raised:
            mirisIntegration.delete_viewer_key(KEY_ID)

        assert raised.value.status_code is None
        assert "ConnectionError" in str(raised.value)
        assert miris_api.integration_key not in str(raised.value)
        assert RESPONSE_BODY not in str(raised.value)
        assert raised.value.__cause__ is None

    def test_timeout_raises(self, miris_api):
        miris_api.responses.append(requests.Timeout())
        with pytest.raises(MirisIntegrationError, match="Timeout"):
            mirisIntegration.delete_viewer_key(KEY_ID)


class TestKeyIdValidation:
    @pytest.mark.parametrize(
        "key_id",
        [
            "",
            None,
            "not-a-uuid",
            "../asset-viewer-key",
            f"{KEY_ID}/../other",
            f"{KEY_ID}?x=1",
            KEY_ID.replace("-", ""),
            "{" + KEY_ID + "}",
            f"{KEY_ID}\n",
        ],
    )
    def test_a_non_uuid_raises_before_any_secret_read_or_request(self, miris_api, key_id):
        with pytest.raises(MirisIntegrationError, match="not a UUID"):
            mirisIntegration.delete_viewer_key(key_id)
        assert miris_api.calls == []
        miris_api.secretsmanager.get_secret_value.assert_not_called()

    def test_an_uppercase_uuid_is_accepted(self, miris_api):
        miris_api.responses.append(204)
        mirisIntegration.delete_viewer_key(KEY_ID.upper())
        assert len(miris_api.calls) == 1


class TestIntegrationKey:
    def test_the_key_is_cached_across_calls(self, miris_api):
        miris_api.responses.extend([204, 204])
        mirisIntegration.delete_viewer_key(KEY_ID)
        mirisIntegration.delete_viewer_key(KEY_ID)
        assert miris_api.secretsmanager.get_secret_value.call_count == 1

    def test_the_key_is_read_again_after_the_cache_window(self, miris_api, monkeypatch):
        miris_api.responses.extend([204, 204])
        mirisIntegration.delete_viewer_key(KEY_ID)
        monkeypatch.setattr(mirisIntegration, "_SECRET_CACHE_TTL_SECONDS", -1)
        mirisIntegration.delete_viewer_key(KEY_ID)
        assert miris_api.secretsmanager.get_secret_value.call_count == 2

    @pytest.mark.parametrize("status", [401, 403])
    def test_an_auth_failure_rereads_the_key_and_retries_once(self, miris_api, status):
        rotated = "rotated-integration-key-do-not-log"
        miris_api.secretsmanager.get_secret_value.side_effect = [
            {"SecretString": miris_api.integration_key},
            {"SecretString": rotated},
        ]
        miris_api.responses.extend([status, 204])

        mirisIntegration.delete_viewer_key(KEY_ID)

        assert [c["headers"]["Miris-API-Key"] for c in miris_api.calls] == [
            miris_api.integration_key,
            rotated,
        ]

    def test_a_second_auth_failure_raises(self, miris_api):
        miris_api.responses.extend([401, 401])
        with pytest.raises(MirisIntegrationError) as raised:
            mirisIntegration.delete_viewer_key(KEY_ID)
        assert raised.value.status_code == 401
        assert len(miris_api.calls) == 2

    def test_a_secrets_manager_failure_raises_without_calling_miris(self, miris_api):
        miris_api.secretsmanager.get_secret_value.side_effect = RuntimeError(
            f"secret detail {miris_api.integration_key}"
        )
        with pytest.raises(MirisIntegrationError) as raised:
            mirisIntegration.delete_viewer_key(KEY_ID)
        assert "RuntimeError" in str(raised.value)
        assert miris_api.integration_key not in str(raised.value)
        assert miris_api.calls == []

    def test_an_empty_secret_raises(self, miris_api):
        miris_api.secretsmanager.get_secret_value.return_value = {"SecretString": "  "}
        with pytest.raises(MirisIntegrationError, match="empty"):
            mirisIntegration.delete_viewer_key(KEY_ID)
        assert miris_api.calls == []

    def test_a_secret_with_surrounding_whitespace_is_trimmed(self, miris_api):
        miris_api.secretsmanager.get_secret_value.return_value = {
            "SecretString": f"  {miris_api.integration_key}\n"
        }
        miris_api.responses.append(204)
        mirisIntegration.delete_viewer_key(KEY_ID)
        assert miris_api.calls[0]["headers"]["Miris-API-Key"] == miris_api.integration_key


class TestConfiguration:
    def test_a_missing_base_url_raises_without_a_request(self, miris_api, monkeypatch):
        monkeypatch.setattr(mirisIntegration, "MIRIS_API_BASE_URL", "")
        with pytest.raises(MirisIntegrationError, match="MIRIS_API_BASE_URL"):
            mirisIntegration.delete_viewer_key(KEY_ID)
        assert miris_api.calls == []

    def test_a_missing_secret_arn_raises_without_a_request(self, miris_api, monkeypatch):
        monkeypatch.setattr(mirisIntegration, "MIRIS_API_KEY_SECRET_ARN", "")
        with pytest.raises(MirisIntegrationError, match="MIRIS_API_KEY_SECRET_ARN"):
            mirisIntegration.delete_viewer_key(KEY_ID)
        assert miris_api.calls == []
        miris_api.secretsmanager.get_secret_value.assert_not_called()


class TestNoSecretInLogs:
    def test_no_path_logs_the_integration_key_or_a_response_body(self, miris_api, log_recorder, caplog):
        caplog.set_level(logging.DEBUG)
        miris_api.responses.extend([404, (401, RESPONSE_BODY), 204, (500, RESPONSE_BODY)])

        mirisIntegration.delete_viewer_key(KEY_ID)
        mirisIntegration.delete_viewer_key(KEY_ID)
        with pytest.raises(MirisIntegrationError):
            mirisIntegration.delete_viewer_key(KEY_ID)

        # Control: the recorder captured the 404 and 401 lines, so an empty log is not what passes.
        assert any(KEY_ID in line for line in log_recorder.lines)
        assert any("401" in line for line in log_recorder.lines)
        for text in (log_recorder.text(), caplog.text):
            assert miris_api.integration_key not in text
            assert RESPONSE_BODY not in text


ASSET_UUID = "8d65af7c-5412-404b-a494-fbd2cdb62442"
VIEWER_KEY_MATERIAL = "minted-viewer-key-material-do-not-log"
EXPIRES_AT = datetime(2026, 10, 15, 19, 4, 28, tzinfo=timezone.utc)


def _created(key_id=KEY_ID, key=VIEWER_KEY_MATERIAL):
    return {
        "id": key_id,
        "key": key,
        "name": "vams:db:asset:1",
        "expires_at": "2026-10-15T19:04:28Z",
        "asset_ids": [ASSET_UUID],
        "tags": None,
    }


class TestCreateViewerKey:
    def test_sends_one_post_scoped_to_exactly_the_asset(self, miris_api):
        miris_api.responses.append((200, _created()))

        mirisIntegration.create_viewer_key(ASSET_UUID, EXPIRES_AT, "vams:db:asset:1")

        assert len(miris_api.calls) == 1
        call = miris_api.calls[0]
        assert call["method"] == "POST"
        assert call["url"] == f"{miris_api.base_url}/v1/asset-viewer-key"
        assert call["headers"]["Miris-API-Key"] == miris_api.integration_key
        assert call["timeout"] == mirisIntegration._REQUEST_TIMEOUT_SECONDS
        assert call["json"] == {
            "name": "vams:db:asset:1",
            "tags": [],
            "asset_ids": [ASSET_UUID],
            "expires_at": "2026-10-15T19:04:28Z",
        }

    def test_returns_the_key_id_material_and_requested_expiry(self, miris_api):
        miris_api.responses.append((200, _created()))
        minted = mirisIntegration.create_viewer_key(ASSET_UUID, EXPIRES_AT, "n")
        assert minted.key_id == KEY_ID
        assert minted.key == VIEWER_KEY_MATERIAL
        assert minted.expires_at == "2026-10-15T19:04:28Z"

    def test_the_key_material_is_not_in_the_repr(self, miris_api):
        miris_api.responses.append((200, _created()))
        minted = mirisIntegration.create_viewer_key(ASSET_UUID, EXPIRES_AT, "n")
        assert VIEWER_KEY_MATERIAL not in repr(minted)
        assert KEY_ID in repr(minted)

    def test_an_expiry_in_another_zone_is_sent_as_utc(self, miris_api):
        miris_api.responses.append((200, _created()))
        local = EXPIRES_AT.astimezone(timezone(timedelta(hours=-7)))
        mirisIntegration.create_viewer_key(ASSET_UUID, local, "n")
        assert miris_api.calls[0]["json"]["expires_at"] == "2026-10-15T19:04:28Z"

    @pytest.mark.parametrize(
        "body",
        [
            {"id": KEY_ID},
            {"id": KEY_ID, "key": ""},
            {"id": KEY_ID, "key": "   "},
            {"id": KEY_ID, "key": 123},
            {"id": "not-a-uuid", "key": VIEWER_KEY_MATERIAL},
            {"key": VIEWER_KEY_MATERIAL},
            [VIEWER_KEY_MATERIAL],
            f"<html>{VIEWER_KEY_MATERIAL}</html>",
        ],
        ids=["no-key", "empty-key", "blank-key", "non-string-key", "bad-id", "no-id", "list", "non-json"],
    )
    def test_a_response_without_a_usable_id_and_key_raises_without_echoing_it(self, miris_api, body):
        miris_api.responses.append((200, body))
        with pytest.raises(MirisIntegrationError, match="no usable key") as raised:
            mirisIntegration.create_viewer_key(ASSET_UUID, EXPIRES_AT, "n")
        assert VIEWER_KEY_MATERIAL not in str(raised.value)

    @pytest.mark.parametrize("status", [400, 404, 409, 429, 500, 503])
    def test_a_non_2xx_raises_with_the_status_code_only(self, miris_api, status):
        miris_api.responses.append((status, RESPONSE_BODY))
        with pytest.raises(MirisIntegrationError) as raised:
            mirisIntegration.create_viewer_key(ASSET_UUID, EXPIRES_AT, "n")
        assert raised.value.status_code == status
        assert RESPONSE_BODY not in str(raised.value)

    @pytest.mark.parametrize("value", ["", "not-a-uuid", f"{ASSET_UUID}/../x", None])
    def test_a_non_uuid_asset_raises_without_a_request(self, miris_api, value):
        with pytest.raises(MirisIntegrationError, match="not a UUID"):
            mirisIntegration.create_viewer_key(value, EXPIRES_AT, "n")
        assert miris_api.calls == []

    def test_neither_key_reaches_the_logs(self, miris_api, log_recorder, caplog):
        caplog.set_level(logging.DEBUG)
        miris_api.responses.extend([(200, _created()), (401, RESPONSE_BODY), (200, _created())])

        mirisIntegration.create_viewer_key(ASSET_UUID, EXPIRES_AT, "n")
        mirisIntegration.create_viewer_key(ASSET_UUID, EXPIRES_AT, "n")

        # Control: the create and the 401 retry were logged.
        assert any(f"Created Miris viewer key {KEY_ID}" in line for line in log_recorder.lines)
        assert any("401" in line for line in log_recorder.lines)
        for text in (log_recorder.text(), caplog.text):
            assert VIEWER_KEY_MATERIAL not in text
            assert miris_api.integration_key not in text
            assert RESPONSE_BODY not in text


class TestGetAssetState:
    def test_sends_one_get_for_the_asset_and_returns_its_state(self, miris_api):
        miris_api.responses.append((200, {"id": ASSET_UUID, "state": "streamable"}))

        assert mirisIntegration.get_asset_state(ASSET_UUID) == "streamable"

        assert len(miris_api.calls) == 1
        call = miris_api.calls[0]
        assert call["method"] == "GET"
        assert call["url"] == f"{miris_api.base_url}/v1/asset/{ASSET_UUID}"
        assert call["headers"]["Miris-API-Key"] == miris_api.integration_key

    def test_404_returns_none(self, miris_api):
        miris_api.responses.append(404)
        assert mirisIntegration.get_asset_state(ASSET_UUID) is None

    @pytest.mark.parametrize("status", [400, 409, 500, 503])
    def test_other_statuses_raise(self, miris_api, status):
        miris_api.responses.append((status, RESPONSE_BODY))
        with pytest.raises(MirisIntegrationError) as raised:
            mirisIntegration.get_asset_state(ASSET_UUID)
        assert raised.value.status_code == status
        assert RESPONSE_BODY not in str(raised.value)

    @pytest.mark.parametrize(
        "body", [{"id": ASSET_UUID}, {"state": 3}, [], "not json"], ids=["no-state", "non-string", "list", "text"]
    )
    def test_a_response_without_a_string_state_raises(self, miris_api, body):
        miris_api.responses.append((200, body))
        with pytest.raises(MirisIntegrationError, match="no state"):
            mirisIntegration.get_asset_state(ASSET_UUID)

    def test_a_non_uuid_raises_without_a_request(self, miris_api):
        with pytest.raises(MirisIntegrationError, match="not a UUID"):
            mirisIntegration.get_asset_state("../v1/asset-viewer-key")
        assert miris_api.calls == []
