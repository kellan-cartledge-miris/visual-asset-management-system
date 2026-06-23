# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""GET /database/{databaseId}/assets/{assetId}/miris/asset-status/{mirisAssetUuid}

Proxies a single GET /v1/asset/{uuid} call to the Miris REST API and returns a
compact status payload the viewer plugin can poll. Used to show a "Miris is
preparing this asset (1-2 hours)" overlay while the asset is still in `preview`
state, and auto-refresh when it flips to `streamable`.

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
secrets_client = boto3.client("secretsmanager", config=retry_config)
logger = safeLogger(service_name="MirisGetAssetStatus")

claims_and_roles = {}

try:
    asset_database = os.environ["ASSET_STORAGE_TABLE_NAME"]
    miris_api_base_url = os.environ["MIRIS_API_BASE_URL"].rstrip("/")
    miris_api_key_secret_arn = os.environ["MIRIS_API_KEY_SECRET_ARN"]
except Exception as e:
    logger.exception("Failed loading environment variables")
    raise e

asset_table = dynamodb.Table(asset_database)

# Lazily-loaded integration key. Cached for the lifetime of the Lambda container
# so we don't hit Secrets Manager on every poll (~40 polls/hr per open tab).
_cached_integration_key = None


def _get_integration_key() -> str:
    global _cached_integration_key
    if _cached_integration_key is None:
        resp = secrets_client.get_secret_value(SecretId=miris_api_key_secret_arn)
        _cached_integration_key = resp["SecretString"].strip()
    return _cached_integration_key


# Per Miris REST API reference (verified 2026-06-22), `state` reaches one of these
# terminal values: preview, streamable, error, failed. `streamable` is what the
# viewer plugin needs to render; the others map to user-facing messaging.
_STREAMABLE_STATE = "streamable"
_ERROR_STATES = ("error", "failed")


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

    # Proxy to Miris
    url = f"{miris_api_base_url}/v1/asset/{miris_asset_uuid}"
    try:
        r = requests.get(
            url,
            headers={"Miris-Integration-Key": _get_integration_key()},
            timeout=15,
        )
    except requests.RequestException as e:
        logger.exception(f"Miris API connection failure: {e}")
        return general_error(
            body={"message": "Could not reach Miris API"}, event=event
        )

    if r.status_code == 404:
        return success(
            body={
                "state": "not_found",
                "isStreamable": False,
                "errorMessage": "The Miris asset referenced by this .mrx no longer exists.",
            }
        )
    if r.status_code >= 300:
        logger.error(
            f"Miris API returned {r.status_code} for {miris_asset_uuid}: {r.text[:200]}"
        )
        return general_error(
            body={"message": f"Miris API error ({r.status_code})"}, event=event
        )

    try:
        body = r.json()
    except json.JSONDecodeError:
        logger.error(f"Miris API returned non-JSON for {miris_asset_uuid}: {r.text[:200]}")
        return general_error(
            body={"message": "Miris API returned unexpected payload"}, event=event
        )

    state = body.get("state", "")
    payload = {
        "state": state,
        "isStreamable": state == _STREAMABLE_STATE,
    }
    if state in _ERROR_STATES:
        payload["errorMessage"] = (
            "Miris processing failed. Check this asset in app.miris.com."
        )
    return success(body=payload)
