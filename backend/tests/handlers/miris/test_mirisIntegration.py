# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""The shared Miris Integration API client: request shape, status handling, Integration Key
caching and rotation, and that no key or response body reaches a log line or exception message."""

import logging

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
