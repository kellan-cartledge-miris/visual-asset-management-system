# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""POST /database/{databaseId}/assets/{assetId}/miris/viewer-key   body: {"filePath": ...}

Mints a short-lived Miris viewer key that can stream only the Miris asset recorded on one asset
file (per-view viewer key mode). The Miris asset UUID is read server side from the file's metadata
(`miris_asset_uuid`), exactly as the stream status endpoint reads it; the request carries no UUID.
`filePath` accepts the same forms as the status endpoint.

The key is created with the Miris Integration Key, with no tags and the one asset ID, and expires
`MIRIS_VIEWER_KEY_TTL_MINUTES` minutes after it is minted. Each key is recorded in
MirisViewerKeyStorageTable under its Miris key ID, with a `ttl` one hour after its expiry; the
viewer key cleanup Lambda deletes the key from Miris when TTL removes the row. The key material is
returned to the caller only, and is never stored, logged or audited.

Response body (200, `Cache-Control: no-store`):

    filePath         the normalized asset-relative path, e.g. "/scene.usd"
    mirisAssetUuid   the Miris asset the key can stream
    viewerKey        the viewer key material
    expiresAt        the key's expiry, RFC 3339 UTC

Errors:

    400  invalid request, missing asset, or `miris_asset_uuid` is not a UUID (`state: invalidUuid`)
    403  Tier 1 or Tier 2 denial
    404  the file records no Miris stream (`state: notStreamed`)
    500  the key could not be recorded (the minted key is deleted from Miris), or misconfiguration
    502  Miris did not create the key

Authorization is two-tier:
  - Tier 1: enforceAPI on the route (POST)
  - Tier 2: enforce GET on the parent asset, before any metadata is read. Minting a key grants
    streaming only, so it is checked as a read of the asset.
"""
import json
import os
import time
from datetime import datetime, timedelta, timezone

import boto3
from aws_lambda_powertools.utilities.parser import ValidationError, parse
from aws_lambda_powertools.utilities.typing import LambdaContext
from botocore.config import Config

from common.apiRoutes import API_MIRIS_VIEWER_KEY
from common.resourceNames import ResourceKeys, get_table_name
from customLogging.auditLogging import log_auth_other
from customLogging.logger import safeLogger
from handlers.auth import request_to_claims
from handlers.authz import CasbinEnforcer
from models.common import (
    APIGatewayProxyResponseV2,
    VAMSGeneralErrorResponse,
    authorization_error,
    general_error,
    internal_error,
    success,
    validation_error,
    validation_error_message,
)
from models.miris import (
    STATE_INVALID_UUID,
    STATE_NOT_STREAMED,
    MintMirisViewerKeyRequestModel,
    MintMirisViewerKeyResponseModel,
)

from . import mirisIntegration
from .streamMetadata import (
    file_path_for_asset,
    read_stream_metadata,
    stream_uuid,
    unusable_uuid_state,
)

retry_config = Config(retries={"max_attempts": 5, "mode": "adaptive"})
dynamodb = boto3.resource("dynamodb", config=retry_config)
logger = safeLogger(service_name="MirisMintViewerKey")

claims_and_roles = {}

try:
    asset_storage_table_name = get_table_name(ResourceKeys.ASSET_STORAGE_TABLE)
    asset_file_metadata_table_name = get_table_name(ResourceKeys.ASSET_FILE_METADATA_STORAGE_TABLE)
    miris_viewer_key_table_name = get_table_name(ResourceKeys.MIRIS_VIEWER_KEY_STORAGE_TABLE)
    # Validated per request, so a bad value fails the mint rather than the import.
    viewer_key_ttl_minutes_setting = os.environ.get("MIRIS_VIEWER_KEY_TTL_MINUTES", "")
except Exception:
    logger.exception("Failed loading resource names")
    raise

asset_table = dynamodb.Table(asset_storage_table_name)
asset_file_metadata_table = dynamodb.Table(asset_file_metadata_table_name)
miris_viewer_key_table = dynamodb.Table(miris_viewer_key_table_name)

# Rows outlive the key by this long, so TTL never removes a row for a key that is still valid.
_ROW_TTL_GRACE_SECONDS = 3600
_TTL_MINUTES_RANGE = range(1, 61)


def lambda_handler(event, context: LambdaContext) -> APIGatewayProxyResponseV2:
    global claims_and_roles
    claims_and_roles = request_to_claims(event)

    try:
        path = event["requestContext"]["http"]["path"]
        method = event["requestContext"]["http"]["method"]

        if len(claims_and_roles["tokens"]) > 0:
            casbin_enforcer = CasbinEnforcer(claims_and_roles)
            if not casbin_enforcer.enforceAPI(event):
                return authorization_error()
        else:
            return authorization_error()

        if method == "POST" and API_MIRIS_VIEWER_KEY.matches(path):
            return _handle_post(event)
        return validation_error(body={"message": "Method not allowed"}, event=event)

    except ValidationError as v:
        logger.exception(f"Validation error: {v}")
        return validation_error(body={"message": validation_error_message(v)}, event=event)
    except VAMSGeneralErrorResponse as v:
        logger.exception(f"VAMS error: {v}")
        return general_error(body={"message": str(v)}, event=event)
    except Exception as e:
        # The type only: a viewer key may exist by now, and an exception message or traceback
        # could carry its material.
        logger.error(f"Internal error ({type(e).__name__})")
    # Answered outside the except block, so a traceback logged by the error response's audit write
    # does not chain the exception.
    return internal_error(event=event)


def _request_body(event) -> dict:
    body = event.get("body")
    if isinstance(body, str):
        try:
            body = json.loads(body) if body.strip() else {}
        except json.JSONDecodeError:
            raise VAMSGeneralErrorResponse("Invalid JSON in request body")
    if body is None:
        return {}
    if not isinstance(body, dict):
        raise VAMSGeneralErrorResponse("Request body must be a JSON object")
    return body


def _viewer_key_ttl_minutes() -> int:
    """MIRIS_VIEWER_KEY_TTL_MINUTES as a whole number of minutes from 1 to 60."""
    ttl_minutes = int(viewer_key_ttl_minutes_setting)
    if ttl_minutes not in _TTL_MINUTES_RANGE:
        raise ValueError("MIRIS_VIEWER_KEY_TTL_MINUTES is outside 1-60")
    return ttl_minutes


def _handle_post(event):
    path_params = event.get("pathParameters") or {}
    body = _request_body(event)

    request_model = parse(
        {
            "databaseId": path_params.get("databaseId"),
            "assetId": path_params.get("assetId"),
            "filePath": body.get("filePath"),
        },
        model=MintMirisViewerKeyRequestModel,
    )
    database_id = request_model.databaseId
    asset_id = request_model.assetId

    # Tier-2: must have GET access to the parent asset
    asset = asset_table.get_item(
        Key={"databaseId": database_id, "assetId": asset_id}
    ).get("Item")
    if not asset:
        return general_error(body={"message": "Asset not found"}, event=event)

    # Casbin policies on asset objects key off object__type='asset'; the
    # DynamoDB record doesn't carry that field, so annotate before enforce().
    asset["object__type"] = "asset"
    casbin_enforcer = CasbinEnforcer(claims_and_roles)
    if not casbin_enforcer.enforce(asset, "GET"):
        return authorization_error()

    file_path = file_path_for_asset(asset, asset_id, request_model.filePath)
    stream_metadata = read_stream_metadata(
        asset_file_metadata_table, database_id, asset_id, file_path
    )
    miris_asset_uuid = stream_uuid(stream_metadata)

    unusable_state = unusable_uuid_state(miris_asset_uuid)
    if unusable_state == STATE_NOT_STREAMED:
        return general_error(
            status_code=404,
            body={"message": "The file records no Miris stream", "state": STATE_NOT_STREAMED},
            event=event,
        )
    if unusable_state == STATE_INVALID_UUID:
        logger.warning("miris_asset_uuid on the file is not a UUID")
        return general_error(
            body={"message": "The file's Miris asset UUID is not a UUID", "state": STATE_INVALID_UUID},
            event=event,
        )

    try:
        ttl_minutes = _viewer_key_ttl_minutes()
    except ValueError:
        logger.error("MIRIS_VIEWER_KEY_TTL_MINUTES is not a whole number of minutes from 1 to 60")
        return internal_error(event=event)

    now = datetime.now(timezone.utc).replace(microsecond=0)
    expires_at = now + timedelta(minutes=ttl_minutes)
    name = f"vams:{database_id}:{asset_id}:{int(time.time() * 1000)}"

    try:
        minted = mirisIntegration.create_viewer_key(miris_asset_uuid, expires_at, name)
    except mirisIntegration.MirisIntegrationError as e:
        logger.error(f"Miris viewer key create failed for {miris_asset_uuid}: {e}")
        return general_error(
            status_code=502,
            body={"message": "Miris did not issue a viewer key"},
            event=event,
        )

    user_id = claims_and_roles["tokens"][0]
    recorded = False
    try:
        miris_viewer_key_table.put_item(
            Item={
                "mirisViewerKeyId": minted.key_id,
                "databaseId": database_id,
                "assetId": asset_id,
                "filePath": file_path,
                "userId": user_id,
                "mirisAssetUuid": miris_asset_uuid,
                "createdAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "expiresAt": minted.expires_at,
                "ttl": int(expires_at.timestamp()) + _ROW_TTL_GRACE_SECONDS,
            },
            ConditionExpression="attribute_not_exists(mirisViewerKeyId)",
        )
        recorded = True
    except Exception as e:
        logger.error(f"Could not record Miris viewer key {minted.key_id} ({type(e).__name__})")
    # Handled outside the except block, so no later traceback chains the put failure.
    if not recorded:
        _delete_unrecorded_key(minted.key_id)
        return internal_error(event=event)

    log_auth_other(
        event,
        "mirisViewerKeyMint",
        {
            "userId": user_id,
            "databaseId": database_id,
            "assetId": asset_id,
            "filePath": file_path,
            "mirisAssetUuid": miris_asset_uuid,
            "mirisViewerKeyId": minted.key_id,
            "expiresAt": minted.expires_at,
        },
    )

    response = MintMirisViewerKeyResponseModel(
        filePath=file_path,
        mirisAssetUuid=miris_asset_uuid,
        viewerKey=minted.key,
        expiresAt=minted.expires_at,
    )
    return success(body=response.dict())


def _delete_unrecorded_key(key_id: str) -> None:
    """Delete a minted key that has no table row, so nothing would ever clean it up."""
    try:
        mirisIntegration.delete_viewer_key(key_id)
        logger.info(f"Deleted unrecorded Miris viewer key {key_id}")
    except Exception as e:
        logger.error(f"Could not delete unrecorded Miris viewer key {key_id} ({type(e).__name__})")
