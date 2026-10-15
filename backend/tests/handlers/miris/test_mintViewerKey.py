# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""POST /database/{databaseId}/assets/{assetId}/miris/viewer-key

A per-view viewer key is minted only after both authorization tiers allow it, only for the Miris
asset recorded on the file itself, and only once its key ID is recorded in the key table. The key
material is returned to the caller and appears in no log line, audit entry, table row or error.
"""

import json
import logging
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from backend.backend.handlers.miris import mintViewerKey

DATABASE_ID = "db-1"
ASSET_ID = "asset-1"
USER_ID = "alice@example.com"
STORED_UUID = "8d65af7c-5412-404b-a494-fbd2cdb62442"
OTHER_UUID = "bc336bab-e3e4-4c50-bd00-9d6cbbd9f194"
KEY_ID = "3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b"
VIEWER_KEY_MATERIAL = "minted-viewer-key-material-do-not-log"
MIRIS_ERROR_BODY = "miris-error-body-must-not-surface"
ROUTE_PATH = f"/database/{DATABASE_ID}/assets/{ASSET_ID}/miris/viewer-key"
SORT_KEY_FIELD = "databaseId:assetId:filePath"
FIXED_NOW = datetime(2026, 10, 15, 18, 49, 28, 734000, tzinfo=timezone.utc)
FIXED_EPOCH_SECONDS = 1792090168.5


def _event(file_path="/scene.usd", method="POST", path=ROUTE_PATH, body=None, raw_body=None):
    if raw_body is None:
        payload = {} if file_path is None else {"filePath": file_path}
        payload.update(body or {})
        raw_body = json.dumps(payload)
    return {
        "requestContext": {"http": {"method": method, "path": path}},
        "pathParameters": {"databaseId": DATABASE_ID, "assetId": ASSET_ID},
        "queryStringParameters": None,
        "headers": {"authorization": "Bearer test-token"},
        "body": raw_body,
    }


def _metadata_table(rows_by_file=None):
    rows_by_file = rows_by_file or {}
    table = MagicMock()

    def get_item(Key):
        value = rows_by_file.get(Key[SORT_KEY_FIELD], {}).get(Key["metadataKey"])
        if value is None:
            return {}
        return {"Item": {"metadataKey": Key["metadataKey"], SORT_KEY_FIELD: Key[SORT_KEY_FIELD], "metadataValue": value}}

    table.get_item.side_effect = get_item
    return table


def _streamed(uuid=STORED_UUID, file_path="/scene.usd"):
    return _metadata_table({f"{DATABASE_ID}:{ASSET_ID}:{file_path}": {"miris_asset_uuid": uuid}})


def _asset_table(found=True, root_key=None):
    table = MagicMock()
    item = {"databaseId": DATABASE_ID, "assetId": ASSET_ID}
    if root_key is not None:
        item["assetLocation"] = {"Key": root_key}
    table.get_item.return_value = {"Item": item} if found else {}
    return table


def _enforcer(api=True, entity=True):
    enforcer = MagicMock()
    enforcer.enforceAPI.return_value = api
    enforcer.enforce.return_value = entity
    return enforcer


def _created(key_id=KEY_ID):
    return {
        "id": key_id,
        "key": VIEWER_KEY_MATERIAL,
        "expires_at": "2026-10-15T19:04:28Z",
        "asset_ids": [STORED_UUID],
        "tags": None,
    }


class _FixedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return FIXED_NOW if tz is not None else FIXED_NOW.replace(tzinfo=None)


def _invoke(event, miris_api, metadata_table=None, asset_table=None, key_table=None,
            enforcer=None, audit=None, ttl_minutes="15"):
    metadata_table = metadata_table if metadata_table is not None else _streamed()
    asset_table = asset_table if asset_table is not None else _asset_table()
    key_table = key_table if key_table is not None else MagicMock()
    enforcer = enforcer if enforcer is not None else _enforcer()
    audit = audit if audit is not None else MagicMock()
    with patch.object(mintViewerKey, "asset_file_metadata_table", metadata_table), \
         patch.object(mintViewerKey, "asset_table", asset_table), \
         patch.object(mintViewerKey, "miris_viewer_key_table", key_table), \
         patch.object(mintViewerKey, "CasbinEnforcer", return_value=enforcer), \
         patch.object(mintViewerKey, "request_to_claims", return_value={"tokens": [USER_ID], "roles": []}), \
         patch.object(mintViewerKey, "log_auth_other", audit), \
         patch.object(mintViewerKey, "viewer_key_ttl_minutes_setting", ttl_minutes), \
         patch.object(mintViewerKey, "datetime", _FixedDatetime), \
         patch.object(mintViewerKey.time, "time", return_value=FIXED_EPOCH_SECONDS):
        response = mintViewerKey.lambda_handler(event, MagicMock())
    return response, json.loads(response["body"])


def _creates(miris_api):
    return [c for c in miris_api.calls if c["method"] == "POST"]


def _deletes(miris_api):
    return [c for c in miris_api.calls if c["method"] == "DELETE"]


@pytest.mark.unit
class TestSuccess:

    def test_returns_the_key_and_its_expiry(self, miris_api):
        miris_api.responses.append((200, _created()))
        response, body = _invoke(_event(), miris_api)

        assert response["statusCode"] == 200
        assert body == {
            "filePath": "/scene.usd",
            "mirisAssetUuid": STORED_UUID,
            "viewerKey": VIEWER_KEY_MATERIAL,
            "expiresAt": "2026-10-15T19:04:28Z",
        }

    def test_the_response_is_not_cacheable(self, miris_api):
        miris_api.responses.append((200, _created()))
        response, _ = _invoke(_event(), miris_api)
        directives = [d.strip() for d in response["headers"]["Cache-Control"].split(",")]
        assert "no-store" in directives

    def test_creates_exactly_one_key_scoped_to_the_files_asset(self, miris_api):
        miris_api.responses.append((200, _created()))
        _invoke(_event(), miris_api)

        creates = _creates(miris_api)
        assert len(creates) == 1
        assert creates[0]["url"] == f"{miris_api.base_url}/v1/asset-viewer-key"
        assert creates[0]["json"] == {
            "name": f"vams:{DATABASE_ID}:{ASSET_ID}:1792090168500",
            "tags": [],
            "asset_ids": [STORED_UUID],
            "expires_at": "2026-10-15T19:04:28Z",
        }
        assert miris_api.calls == creates

    @pytest.mark.parametrize("ttl_minutes, expires_at", [("1", "2026-10-15T18:50:28Z"), ("60", "2026-10-15T19:49:28Z")])
    def test_the_expiry_follows_the_configured_ttl(self, miris_api, ttl_minutes, expires_at):
        miris_api.responses.append((200, _created()))
        response, body = _invoke(_event(), miris_api, ttl_minutes=ttl_minutes)
        assert response["statusCode"] == 200
        assert body["expiresAt"] == expires_at
        assert _creates(miris_api)[0]["json"]["expires_at"] == expires_at

    def test_records_one_row_without_the_key_material(self, miris_api):
        miris_api.responses.append((200, _created()))
        key_table = MagicMock()
        _invoke(_event(), miris_api, key_table=key_table)

        key_table.put_item.assert_called_once()
        kwargs = key_table.put_item.call_args.kwargs
        expiry_epoch = int(datetime(2026, 10, 15, 19, 4, 28, tzinfo=timezone.utc).timestamp())
        assert kwargs["Item"] == {
            "mirisViewerKeyId": KEY_ID,
            "databaseId": DATABASE_ID,
            "assetId": ASSET_ID,
            "filePath": "/scene.usd",
            "userId": USER_ID,
            "mirisAssetUuid": STORED_UUID,
            "createdAt": "2026-10-15T18:49:28Z",
            "expiresAt": "2026-10-15T19:04:28Z",
            "ttl": expiry_epoch + 3600,
        }
        # The put never overwrites the row of an existing key ID.
        condition = kwargs["ConditionExpression"]
        assert "attribute_not_exists" in condition and "mirisViewerKeyId" in condition
        assert VIEWER_KEY_MATERIAL not in json.dumps(kwargs)

    def test_audits_the_issuance_without_the_key_material(self, miris_api):
        miris_api.responses.append((200, _created()))
        audit = MagicMock()
        event = _event()
        _invoke(event, miris_api, audit=audit)

        audit.assert_called_once()
        audit_event, secondary_type, data = audit.call_args.args
        assert audit_event is event
        assert secondary_type == "mirisViewerKeyMint"
        assert data == {
            "userId": USER_ID,
            "databaseId": DATABASE_ID,
            "assetId": ASSET_ID,
            "filePath": "/scene.usd",
            "mirisAssetUuid": STORED_UUID,
            "mirisViewerKeyId": KEY_ID,
            "expiresAt": "2026-10-15T19:04:28Z",
        }
        assert VIEWER_KEY_MATERIAL not in json.dumps(audit.call_args.args[1:])

    def test_a_full_object_key_is_normalized_against_the_assets_root(self, miris_api):
        miris_api.responses.append((200, _created()))
        response, body = _invoke(
            _event(f"/assets/{ASSET_ID}/folder/scene.usd"),
            miris_api,
            metadata_table=_streamed(file_path="/folder/scene.usd"),
            asset_table=_asset_table(root_key=f"assets/{ASSET_ID}/"),
        )
        assert response["statusCode"] == 200
        assert body["filePath"] == "/folder/scene.usd"

    def test_a_client_supplied_uuid_is_ignored(self, miris_api):
        miris_api.responses.append((200, _created()))
        response, body = _invoke(_event(body={"mirisAssetUuid": OTHER_UUID}), miris_api)
        assert response["statusCode"] == 200
        assert body["mirisAssetUuid"] == STORED_UUID
        assert _creates(miris_api)[0]["json"]["asset_ids"] == [STORED_UUID]


@pytest.mark.unit
class TestAuthorization:

    def test_tier1_denial_is_403_before_any_read_or_miris_call(self, miris_api):
        asset_table = _asset_table()
        metadata_table = _streamed()
        key_table = MagicMock()
        response, _ = _invoke(
            _event(), miris_api, asset_table=asset_table, metadata_table=metadata_table,
            key_table=key_table, enforcer=_enforcer(api=False),
        )
        assert response["statusCode"] == 403
        asset_table.get_item.assert_not_called()
        metadata_table.get_item.assert_not_called()
        key_table.put_item.assert_not_called()
        assert miris_api.calls == []

    def test_tier2_denial_is_403_before_any_metadata_read_or_miris_call(self, miris_api):
        metadata_table = _streamed()
        key_table = MagicMock()
        response, _ = _invoke(
            _event(), miris_api, metadata_table=metadata_table, key_table=key_table,
            enforcer=_enforcer(entity=False),
        )
        assert response["statusCode"] == 403
        metadata_table.get_item.assert_not_called()
        key_table.put_item.assert_not_called()
        assert miris_api.calls == []

    def test_tier2_is_checked_as_a_read_of_the_asset(self, miris_api):
        miris_api.responses.append((200, _created()))
        enforcer = _enforcer()
        _invoke(_event(), miris_api, enforcer=enforcer)
        asset_arg, action = enforcer.enforce.call_args.args
        assert action == "GET"
        assert asset_arg["object__type"] == "asset"
        assert asset_arg["assetId"] == ASSET_ID

    def test_no_caller_identity_is_403(self, miris_api):
        with patch.object(mintViewerKey, "request_to_claims", return_value={"tokens": [], "roles": []}):
            response = mintViewerKey.lambda_handler(_event(), MagicMock())
        assert response["statusCode"] == 403
        assert miris_api.calls == []

    def test_a_missing_asset_is_400_without_a_miris_call(self, miris_api):
        response, body = _invoke(_event(), miris_api, asset_table=_asset_table(found=False))
        assert response["statusCode"] == 400
        assert body["message"] == "Asset not found"
        assert miris_api.calls == []


@pytest.mark.unit
class TestTheFilesStream:

    def test_no_stream_on_the_file_is_404_not_streamed(self, miris_api):
        response, body = _invoke(_event(), miris_api, metadata_table=_metadata_table())
        assert response["statusCode"] == 404
        assert body["state"] == "notStreamed"
        assert miris_api.calls == []

    def test_an_empty_uuid_is_404_not_streamed(self, miris_api):
        response, body = _invoke(_event(), miris_api, metadata_table=_streamed(uuid="  "))
        assert response["statusCode"] == 404
        assert body["state"] == "notStreamed"
        assert miris_api.calls == []

    def test_a_stream_on_another_file_is_not_used(self, miris_api):
        response, body = _invoke(_event("/scene.usd"), miris_api, metadata_table=_streamed(file_path="/other.usd"))
        assert response["statusCode"] == 404
        assert body["state"] == "notStreamed"
        assert miris_api.calls == []

    def test_a_non_uuid_is_400_invalid_uuid(self, miris_api):
        response, body = _invoke(_event(), miris_api, metadata_table=_streamed(uuid="not-a-uuid"))
        assert response["statusCode"] == 400
        assert body["state"] == "invalidUuid"
        assert miris_api.calls == []


@pytest.mark.unit
class TestRequestValidation:

    @pytest.mark.parametrize(
        "event",
        [
            _event(None),
            _event(""),
            _event("/"),
            _event("/../secret.usd"),
            _event("/folder/"),
            _event(raw_body="{not json"),
            _event(raw_body="[]"),
            _event(raw_body=""),
        ],
        ids=["missing", "empty", "root", "traversal", "folder", "bad-json", "array", "empty-body"],
    )
    def test_an_invalid_request_is_400_without_any_read(self, miris_api, event):
        asset_table = _asset_table()
        response, _ = _invoke(event, miris_api, asset_table=asset_table)
        assert response["statusCode"] == 400
        asset_table.get_item.assert_not_called()
        assert miris_api.calls == []

    @pytest.mark.parametrize("method", ["GET", "PUT", "DELETE"])
    def test_other_methods_are_rejected(self, miris_api, method):
        response, _ = _invoke(_event(method=method), miris_api)
        assert response["statusCode"] == 400
        assert miris_api.calls == []

    def test_the_status_route_is_not_dispatched(self, miris_api):
        status_path = f"/database/{DATABASE_ID}/assets/{ASSET_ID}/miris/asset-status"
        response, _ = _invoke(_event(path=status_path), miris_api)
        assert response["statusCode"] == 400
        assert miris_api.calls == []

    @pytest.mark.parametrize("ttl_minutes", ["", "0", "61", "15.5", "abc"])
    def test_a_bad_ttl_setting_is_500_without_a_miris_call(self, miris_api, ttl_minutes):
        response, _ = _invoke(_event(), miris_api, ttl_minutes=ttl_minutes)
        assert response["statusCode"] == 500
        assert miris_api.calls == []


@pytest.mark.unit
class TestFailures:

    @pytest.mark.parametrize(
        "outcome",
        [(500, MIRIS_ERROR_BODY), (400, MIRIS_ERROR_BODY), (200, {"id": KEY_ID}), (200, MIRIS_ERROR_BODY)],
        ids=["500", "400", "no-key", "non-json"],
    )
    def test_a_miris_failure_is_502_without_the_miris_body(self, miris_api, outcome):
        miris_api.responses.append(outcome)
        key_table = MagicMock()
        audit = MagicMock()
        response, body = _invoke(_event(), miris_api, key_table=key_table, audit=audit)

        assert response["statusCode"] == 502
        assert MIRIS_ERROR_BODY not in response["body"]
        assert "viewerKey" not in body
        key_table.put_item.assert_not_called()
        audit.assert_not_called()

    def test_a_transport_failure_is_502(self, miris_api):
        import requests

        miris_api.responses.append(requests.ConnectionError(MIRIS_ERROR_BODY))
        response, _ = _invoke(_event(), miris_api)
        assert response["statusCode"] == 502
        assert MIRIS_ERROR_BODY not in response["body"]

    @pytest.mark.parametrize(
        "error",
        [
            ClientError({"Error": {"Code": "ConditionalCheckFailedException", "Message": "exists"}}, "PutItem"),
            ClientError({"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "slow"}}, "PutItem"),
            RuntimeError("boom"),
        ],
        ids=["duplicate-id", "throttled", "other"],
    )
    def test_a_failed_table_put_deletes_the_minted_key_and_is_500(self, miris_api, error):
        miris_api.responses.extend([(200, _created()), 204])
        key_table = MagicMock()
        key_table.put_item.side_effect = error
        audit = MagicMock()
        response, body = _invoke(_event(), miris_api, key_table=key_table, audit=audit)

        assert response["statusCode"] == 500
        assert VIEWER_KEY_MATERIAL not in response["body"]
        deletes = _deletes(miris_api)
        assert [c["url"] for c in deletes] == [f"{miris_api.base_url}/v1/asset-viewer-key/{KEY_ID}"]
        audit.assert_not_called()

    def test_a_failed_cleanup_delete_still_returns_500(self, miris_api):
        miris_api.responses.extend([(200, _created()), (503, MIRIS_ERROR_BODY)])
        key_table = MagicMock()
        key_table.put_item.side_effect = RuntimeError("boom")
        response, _ = _invoke(_event(), miris_api, key_table=key_table)
        assert response["statusCode"] == 500
        assert len(_deletes(miris_api)) == 1


@pytest.mark.unit
class TestNoKeyMaterialInLogs:

    def test_no_path_logs_the_key_material_or_a_secret(self, miris_api, log_recorder, caplog):
        caplog.set_level(logging.DEBUG)
        failing_table = MagicMock()
        failing_table.put_item.side_effect = RuntimeError(f"boom {VIEWER_KEY_MATERIAL}")
        miris_api.responses.extend([
            (200, _created()),                 # success
            (200, _created()), (503, MIRIS_ERROR_BODY),  # put fails, cleanup delete fails
            (500, MIRIS_ERROR_BODY),            # create fails
        ])

        _invoke(_event(), miris_api)
        _invoke(_event(), miris_api, key_table=failing_table)
        _invoke(_event(), miris_api)

        # Control: each path was logged, so an empty log is not what passes.
        text = log_recorder.text()
        assert f"Created Miris viewer key {KEY_ID}" in text
        assert f"Could not record Miris viewer key {KEY_ID}" in text
        assert f"Could not delete unrecorded Miris viewer key {KEY_ID}" in text
        assert "HTTP 500" in text
        for logged in (text, caplog.text):
            assert VIEWER_KEY_MATERIAL not in logged
            assert miris_api.integration_key not in logged
            assert MIRIS_ERROR_BODY not in logged
