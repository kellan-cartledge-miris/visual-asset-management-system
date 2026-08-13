# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""GET /database/{databaseId}/assets/{assetId}/miris/asset-status/{mirisAssetUuid}

Proxies a single GET /viewer/v1/asset/{uuid} call to the Miris viewer API and
returns a compact status payload the viewer plugin can poll. Used to show a
"Miris is preparing this asset (1-2 hours)" overlay while the asset is still in
`preview` state, and auto-refresh when it flips to `streamable`.

This uses the **viewer key**, deliberately, not the Integration Key. Streaming
itself only ever needs the viewer key (the frontend SDK authenticates with it),
so scoping this status probe to the same credential guarantees it can see
exactly the assets the viewer can stream. Integration Keys resolve to the owning
Miris user's home workspace, which is administratively mutable and can drift
away from the workspace holding the assets — when that happened, every status
probe 404'd and (because the frontend treated that as fatal) blocked streaming
that the viewer key could otherwise serve fine. The Integration Key remains
correct for the upload pipeline, which must *create* assets.

This endpoint is advisory only: it drives a progress overlay. It must never be
able to block streaming, so anything short of a definitive Miris processing
failure is reported as indeterminate and the client proceeds optimistically.

Authorization is two-tier:
  - Tier 1: enforceAPI on the route
  - Tier 2: enforce GET on the parent asset (same check that gates opening the
    asset detail page or downloading the .mrx)
"""
import json
import os

import boto3
import requests
from aws_lambda_powertools.utilities.parser import ValidationError
from aws_lambda_powertools.utilities.typing import LambdaContext
from botocore.config import Config

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
)

retry_config = Config(retries={"max_attempts": 5, "mode": "adaptive"})
dynamodb = boto3.resource("dynamodb", config=retry_config)
logger = safeLogger(service_name="MirisGetAssetStatus")

claims_and_roles = {}

try:
    asset_database = os.environ["ASSET_STORAGE_TABLE_NAME"]
    miris_api_base_url = os.environ["MIRIS_API_BASE_URL"].rstrip("/")
    # Deployment-wide Miris viewer key, the same credential the frontend streams
    # with. Injected by the CDK lambda builder from config.app.miris.viewerKey.
    miris_viewer_key = os.environ.get("MIRIS_VIEWER_KEY", "").strip()
except Exception as e:
    logger.exception("Failed loading environment variables")
    raise e

asset_table = dynamodb.Table(asset_database)

# Per Miris REST API reference (verified 2026-06-22), `state` reaches one of these
# terminal values: preview, streamable, error, failed. `streamable` is what the
# viewer plugin needs to render; the others map to user-facing messaging.
_STREAMABLE_STATE = "streamable"
_ERROR_STATES = ("error", "failed")


def _indeterminate(reason: str) -> APIGatewayProxyResponseV2:
    """Status could not be determined — tell the client to proceed optimistically.

    Deliberately carries no `errorMessage`: the client treats that field as a
    definitive processing failure and blocks rendering on it. An indeterminate
    probe (asset not visible to the viewer key, viewer key unset, malformed
    payload) must not stop a stream that the Miris SDK may well be able to play,
    so the SDK is left to be the source of truth.
    """
    logger.warning(f"Miris asset status indeterminate: {reason}")
    return success(
        body={
            "state": "unknown",
            "isStreamable": False,
            "indeterminate": True,
        }
    )


def lambda_handler(event, context: LambdaContext) -> APIGatewayProxyResponseV2:
    global claims_and_roles
    claims_and_roles = request_to_claims(event)

    try:
        method = event["requestContext"]["http"]["method"]
        if method != "GET":
            return validation_error(
                body={"message": "Method not allowed"}, event=event
            )

        if len(claims_and_roles["tokens"]) > 0:
            casbin_enforcer = CasbinEnforcer(claims_and_roles)
            if not casbin_enforcer.enforceAPI(event):
                return authorization_error()
        else:
            return authorization_error()

        return _handle_get(event)

    except ValidationError as v:
        logger.exception(f"Validation error: {v}")
        return validation_error(body={"message": str(v)}, event=event)
    except VAMSGeneralErrorResponse as v:
        logger.exception(f"VAMS error: {v}")
        return general_error(body={"message": str(v)}, event=event)
    except Exception as e:
        logger.exception(f"Internal error: {e}")
        return internal_error(event=event)


def _handle_get(event):
    path_params = event.get("pathParameters", {}) or {}
    database_id = path_params.get("databaseId")
    asset_id = path_params.get("assetId")
    miris_asset_uuid = path_params.get("mirisAssetUuid")

    if not database_id or not asset_id or not miris_asset_uuid:
        return validation_error(
            body={"message": "databaseId, assetId, and mirisAssetUuid are required"},
            event=event,
        )

    (valid, message) = validate(
        {
            "databaseId": {"value": database_id, "validator": "ID"},
            "assetId": {"value": asset_id, "validator": "ASSET_ID"},
            "mirisAssetUuid": {"value": miris_asset_uuid, "validator": "UUID"},
        }
    )
    if not valid:
        return validation_error(body={"message": message}, event=event)

    # Tier-2: must have GET access to the parent asset
    asset_resp = asset_table.get_item(
        Key={"databaseId": database_id, "assetId": asset_id}
    )
    asset = asset_resp.get("Item")
    if not asset:
        return general_error(
            body={"message": "Asset not found"}, event=event
        )

    # Casbin policies on asset objects key off object__type='asset'; the
    # DynamoDB record doesn't carry that field, so annotate before enforce().
    # See backend/CLAUDE.md anti-pattern #3 (Missing object__type annotation).
    asset["object__type"] = "asset"
    casbin_enforcer = CasbinEnforcer(claims_and_roles)
    if not casbin_enforcer.enforce(asset, "GET"):
        return authorization_error()

    # A deployment with the upload pipeline on but no viewer key configured can
    # still reach this route; degrade to indeterminate rather than erroring.
    if not miris_viewer_key:
        return _indeterminate("MIRIS_VIEWER_KEY is not configured")

    # Proxy to the Miris viewer API using the viewer key (see module docstring for
    # why this is not the Integration Key).
    #
    # The key goes in a header, never the query string. The viewer API accepts
    # both, but a `?viewerKey=` URL leaks the credential into anything that
    # records URLs — and `requests` embeds the full URL in its exception messages,
    # so a single connection error would write the key into CloudWatch.
    url = f"{miris_api_base_url}/viewer/v1/asset/{miris_asset_uuid}"
    try:
        r = requests.get(
            url,
            headers={"Miris-Viewer-Key": miris_viewer_key},
            timeout=15,
        )
    except requests.RequestException as e:
        logger.exception(f"Miris API connection failure: {e}")
        return general_error(
            body={"message": "Could not reach Miris API"}, event=event
        )

    if r.status_code == 404:
        # Not visible to the viewer key. This is NOT proof the asset is gone: it
        # also covers an asset still being ingested and any workspace-visibility
        # drift. Report indeterminate so the client still attempts the stream.
        return _indeterminate(f"viewer API returned 404 for {miris_asset_uuid}")
    if r.status_code >= 300:
        logger.error(
            f"Miris API returned {r.status_code} for {miris_asset_uuid}: {r.text[:200]}"
        )
        return _indeterminate(f"viewer API returned {r.status_code}")

    try:
        body = r.json()
    except json.JSONDecodeError:
        logger.error(f"Miris API returned non-JSON for {miris_asset_uuid}: {r.text[:200]}")
        return _indeterminate("viewer API returned a non-JSON payload")

    state = body.get("state", "")
    payload = {
        "state": state,
        "isStreamable": state == _STREAMABLE_STATE,
    }
    # Only a definitive Miris-side processing failure is surfaced as a blocking
    # error; every other non-streamable state drives the "preparing" overlay.
    if state in _ERROR_STATES:
        payload["errorMessage"] = (
            "Miris processing failed. Check this asset in app.miris.com."
        )
    elif not payload["isStreamable"] and not state:
        # 200 with no usable state — treat as indeterminate, not "processing".
        return _indeterminate("viewer API response contained no state field")
    return success(body=payload)
