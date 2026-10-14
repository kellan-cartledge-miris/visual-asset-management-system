# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""GET /database/{databaseId}/assets/{assetId}/miris/asset-status?filePath=<path or object key>

Reports the Miris stream recorded on one asset file. The Miris asset UUID is read server side
from the file's metadata (`miris_asset_uuid` in the asset file metadata table, keyed by exactly
this databaseId, assetId and filePath). The request carries no UUID, so a caller can only learn
the status of a stream that the file itself references.

`filePath` is the asset-relative path (`/folder/scene.usd`) or the file's full object key. A
key under the asset's root key (`assetLocation.Key`) or under `{assetId}/` is reduced to the
relative path the metadata service stores the file's metadata under.

Response body:

    filePath         the normalized asset-relative path, e.g. "/scene.usd"
    mirisAssetUuid   `miris_asset_uuid`, or null when it is absent or empty
    sourceVersionId  `miris_source_version_id`, or null when absent ("" when the source
                     version was not known at upload time)
    uploadedAt       `miris_uploaded_at` (ISO 8601), or null when absent
    displayName      `miris_display_name`, or null when absent
    state            one of the states below

States:

    notStreamed    `miris_asset_uuid` is absent or empty. Miris is not called.
    invalidUuid    `miris_asset_uuid` is set but is not a UUID. Miris is not called.
    unknown        The processing state could not be established. Either no viewer key or
                   Miris API base URL is configured (Miris is not called), or Miris was
                   unreachable, returned 404 or another non-2xx status, or returned a payload
                   without a usable `state`.
    <Miris state>  The processing state reported by the Miris viewer API, passed through as
                   is: `preview` while Miris prepares the asset, `streamable` once it can be
                   streamed, and `error` or `failed` for a definitive processing failure.

The status probe authenticates with the deployment-wide viewer key, the same credential the
frontend streams with, so it sees exactly the assets the viewer can stream. It does not use the
Integration Key: that key resolves to its owning Miris user's home workspace, which is
administratively mutable and can drift away from the workspace holding the assets. The
Integration Key stays with the upload pipeline, which must create assets.

The probe is advisory and must never block streaming. Everything short of a definitive Miris
processing failure is reported as `unknown`, and the response still carries the UUID so the
client can attempt the stream.

Authorization is two-tier:
  - Tier 1: enforceAPI on the route
  - Tier 2: enforce GET on the parent asset, before any metadata is read
"""
import os
import re

import boto3
import requests
from aws_lambda_powertools.utilities.parser import ValidationError, parse
from aws_lambda_powertools.utilities.typing import LambdaContext
from botocore.config import Config

from common.apiRoutes import API_MIRIS_ASSET_STATUS
from common.resourceNames import ResourceKeys, get_table_name
from common.validators import validate
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
    MIRIS_ASSET_UUID_KEY,
    MIRIS_DISPLAY_NAME_KEY,
    MIRIS_SOURCE_VERSION_ID_KEY,
    MIRIS_STREAM_METADATA_KEYS,
    MIRIS_UPLOADED_AT_KEY,
    STATE_INVALID_UUID,
    STATE_NOT_STREAMED,
    STATE_UNKNOWN,
    GetMirisAssetStatusRequestModel,
    MirisAssetStatusResponseModel,
    asset_relative_file_path,
)

retry_config = Config(retries={"max_attempts": 5, "mode": "adaptive"})
dynamodb = boto3.resource("dynamodb", config=retry_config)
logger = safeLogger(service_name="MirisGetAssetStatus")

claims_and_roles = {}

try:
    asset_storage_table_name = get_table_name(ResourceKeys.ASSET_STORAGE_TABLE)
    asset_file_metadata_table_name = get_table_name(ResourceKeys.ASSET_FILE_METADATA_STORAGE_TABLE)
    miris_api_base_url = os.environ.get("MIRIS_API_BASE_URL", "").strip().rstrip("/")
    # Deployment-wide Miris viewer key, the same credential the frontend streams with.
    miris_viewer_key = os.environ.get("MIRIS_VIEWER_KEY", "").strip()
except Exception:
    logger.exception("Failed loading resource names")
    raise

asset_table = dynamodb.Table(asset_storage_table_name)
asset_file_metadata_table = dynamodb.Table(asset_file_metadata_table_name)

# A Miris `state` is passed through only when it looks like a state token.
_MIRIS_STATE_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")


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

        if method == "GET" and API_MIRIS_ASSET_STATUS.matches(path):
            return _handle_get(event)
        return validation_error(body={"message": "Method not allowed"}, event=event)

    except ValidationError as v:
        logger.exception(f"Validation error: {v}")
        return validation_error(body={"message": validation_error_message(v)}, event=event)
    except VAMSGeneralErrorResponse as v:
        logger.exception(f"VAMS error: {v}")
        return general_error(body={"message": str(v)}, event=event)
    except Exception as e:
        logger.exception(f"Internal error: {e}")
        return internal_error(event=event)


def _handle_get(event):
    path_params = event.get("pathParameters") or {}
    query_params = event.get("queryStringParameters") or {}

    request_model = parse(
        {
            "databaseId": path_params.get("databaseId"),
            "assetId": path_params.get("assetId"),
            "filePath": query_params.get("filePath"),
        },
        model=GetMirisAssetStatusRequestModel,
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

    # A full object key is reduced against this asset's own root key only.
    asset_location = asset.get("assetLocation")
    asset_root_key = asset_location.get("Key") if isinstance(asset_location, dict) else None
    file_path = asset_relative_file_path(request_model.filePath, asset_id, asset_root_key)

    stream_metadata = _read_stream_metadata(database_id, asset_id, file_path)

    miris_asset_uuid = (stream_metadata.get(MIRIS_ASSET_UUID_KEY) or "").strip()
    response = MirisAssetStatusResponseModel(
        filePath=file_path,
        mirisAssetUuid=miris_asset_uuid or None,
        sourceVersionId=stream_metadata.get(MIRIS_SOURCE_VERSION_ID_KEY),
        uploadedAt=stream_metadata.get(MIRIS_UPLOADED_AT_KEY),
        displayName=stream_metadata.get(MIRIS_DISPLAY_NAME_KEY),
        state=_stream_state(miris_asset_uuid),
    )
    return success(body=response.dict())


def _read_stream_metadata(database_id: str, asset_id: str, file_path: str) -> dict:
    """Read the Miris stream keys stored on one file, as {metadataKey: string value}.

    Each key is a single-item read on (metadataKey, databaseId:assetId:filePath), so only
    rows belonging to this exact file can be returned. Absent keys are omitted.
    """
    sort_key = f"{database_id}:{asset_id}:{file_path}"
    values = {}
    for metadata_key in MIRIS_STREAM_METADATA_KEYS:
        item = asset_file_metadata_table.get_item(
            Key={"metadataKey": metadata_key, "databaseId:assetId:filePath": sort_key}
        ).get("Item")
        if not item or item.get("metadataValue") is None:
            continue
        value = item["metadataValue"]
        values[metadata_key] = value if isinstance(value, str) else str(value)
    return values


def _stream_state(miris_asset_uuid: str) -> str:
    """Resolve the response `state` for the UUID stored on the file."""
    if not miris_asset_uuid:
        return STATE_NOT_STREAMED

    (valid, _message) = validate(
        {"mirisAssetUuid": {"value": miris_asset_uuid, "validator": "UUID"}}
    )
    if not valid:
        logger.warning("miris_asset_uuid on the file is not a UUID")
        return STATE_INVALID_UUID

    if not miris_viewer_key or not miris_api_base_url:
        logger.warning("Miris viewer key or API base URL is not configured")
        return STATE_UNKNOWN

    return _miris_processing_state(miris_asset_uuid)


def _miris_processing_state(miris_asset_uuid: str) -> str:
    """Ask the Miris viewer API for the asset's processing state.

    The key goes in a header, never the query string: a `?viewerKey=` URL leaks the
    credential into anything that records URLs, and `requests` embeds the full URL in its
    exception messages.
    """
    url = f"{miris_api_base_url}/viewer/v1/asset/{miris_asset_uuid}"
    try:
        r = requests.get(
            url,
            headers={"Miris-Viewer-Key": miris_viewer_key},
            timeout=15,
        )
    except requests.RequestException as e:
        logger.warning(f"Miris API connection failure: {e}")
        return STATE_UNKNOWN

    if r.status_code == 404:
        # Not visible to the viewer key. This is not proof the asset is gone: it also covers
        # an asset still being ingested and any workspace-visibility drift.
        logger.warning(f"Miris viewer API returned 404 for {miris_asset_uuid}")
        return STATE_UNKNOWN
    if r.status_code >= 300:
        logger.error(
            f"Miris API returned {r.status_code} for {miris_asset_uuid}: {r.text[:200]}"
        )
        return STATE_UNKNOWN

    try:
        body = r.json()
    except ValueError:
        logger.error(f"Miris API returned non-JSON for {miris_asset_uuid}: {r.text[:200]}")
        return STATE_UNKNOWN

    state = body.get("state") if isinstance(body, dict) else None
    if not isinstance(state, str) or not _MIRIS_STATE_PATTERN.fullmatch(state):
        logger.warning("Miris viewer API response contained no usable state")
        return STATE_UNKNOWN
    return state
