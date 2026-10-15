# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Miris Integration API client shared by the Miris handlers.

Authenticates with the Miris Integration Key, a plain-string Secrets Manager secret named by
`MIRIS_API_KEY_SECRET_ARN`, and calls the Miris API at `MIRIS_API_BASE_URL`. The key is cached
per container for `_SECRET_CACHE_TTL_SECONDS`, so a rotated key is picked up within that window;
a 401 or 403 drops the cached key and retries the call once with a freshly read one.

Neither the Integration Key nor any viewer key material is ever logged or placed in an exception
message. Viewer key IDs may be logged. A failed call raises `MirisIntegrationError`, whose message
carries at most the HTTP status code, never the Miris response body.
"""
import os
import re
import time
from typing import Any, Optional

import boto3
import requests
from botocore.config import Config

from customLogging.logger import safeLogger

logger = safeLogger(service_name="MirisIntegration")

_retry_config = Config(retries={"max_attempts": 5, "mode": "adaptive"})

# (connect, read) seconds for every Miris API request.
_REQUEST_TIMEOUT_SECONDS = (5, 15)

# How long the Integration Key read from Secrets Manager is reused before it is fetched again.
_SECRET_CACHE_TTL_SECONDS = 3600

_API_KEY_HEADER = "Miris-API-Key"

# Miris viewer key IDs are UUIDs. Checked before an ID is placed in a request path.
_VIEWER_KEY_ID_PATTERN = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)

# Lazy module-level singletons, kept across warm invocations.
_secretsmanager = None
_cached_api_key: Optional[str] = None
_cached_api_key_fetched_at: float = 0.0

# Module-level config, read once at cold start.
try:
    MIRIS_API_KEY_SECRET_ARN = os.environ["MIRIS_API_KEY_SECRET_ARN"].strip()
    MIRIS_API_BASE_URL = os.environ["MIRIS_API_BASE_URL"].strip().rstrip("/")
except KeyError as e:
    logger.warning(f"Miris integration env vars not set at import time (OK during test collection): {e}")
    MIRIS_API_KEY_SECRET_ARN = os.environ.get("MIRIS_API_KEY_SECRET_ARN", "").strip()
    MIRIS_API_BASE_URL = os.environ.get("MIRIS_API_BASE_URL", "").strip().rstrip("/")


class MirisIntegrationError(Exception):
    """A Miris Integration API call failed.

    `status_code` is the HTTP status Miris returned, or None when no response was received.
    """

    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


def is_viewer_key_id(value: Any) -> bool:
    """True when `value` is a string in the UUID form Miris uses for viewer key IDs."""
    return isinstance(value, str) and bool(_VIEWER_KEY_ID_PATTERN.fullmatch(value))


def _get_secretsmanager_client():
    global _secretsmanager
    if _secretsmanager is None:
        _secretsmanager = boto3.client("secretsmanager", config=_retry_config)
    return _secretsmanager


def _load_api_key() -> str:
    """Return the Miris Integration Key, read from Secrets Manager or the module cache."""
    global _cached_api_key, _cached_api_key_fetched_at
    if (
        _cached_api_key is not None
        and (time.time() - _cached_api_key_fetched_at) < _SECRET_CACHE_TTL_SECONDS
    ):
        return _cached_api_key
    if not MIRIS_API_KEY_SECRET_ARN:
        raise MirisIntegrationError("MIRIS_API_KEY_SECRET_ARN is not configured")
    try:
        response = _get_secretsmanager_client().get_secret_value(SecretId=MIRIS_API_KEY_SECRET_ARN)
    except Exception as e:
        raise MirisIntegrationError(
            f"Could not read the Miris Integration Key secret ({type(e).__name__})"
        ) from None
    api_key = (response.get("SecretString") or "").strip()
    if not api_key:
        raise MirisIntegrationError("The Miris Integration Key secret is empty")
    _cached_api_key = api_key
    _cached_api_key_fetched_at = time.time()
    return _cached_api_key


def _invalidate_api_key_cache() -> None:
    """Drop the cached Integration Key so the next call re-reads Secrets Manager."""
    global _cached_api_key
    _cached_api_key = None


def _request(method: str, path: str, json_body: Optional[dict] = None) -> requests.Response:
    """Send one authenticated request to the Miris API and return the response.

    `path` starts with "/" and is appended to `MIRIS_API_BASE_URL`. A 401 or 403 is retried once
    with a freshly read Integration Key. Any response is returned to the caller, which decides
    which status codes count as success. A transport failure raises `MirisIntegrationError`.
    """
    if not MIRIS_API_BASE_URL:
        raise MirisIntegrationError("MIRIS_API_BASE_URL is not configured")
    url = f"{MIRIS_API_BASE_URL}{path}"
    response = None
    for attempt in range(2):
        headers = {_API_KEY_HEADER: _load_api_key(), "Accept": "application/json"}
        try:
            response = requests.request(
                method,
                url,
                headers=headers,
                json=json_body,
                timeout=_REQUEST_TIMEOUT_SECONDS,
            )
        except requests.RequestException as e:
            raise MirisIntegrationError(f"Miris {method} request failed ({type(e).__name__})") from None
        if response.status_code in (401, 403) and attempt == 0:
            logger.warning(f"Miris {method} returned HTTP {response.status_code}; re-reading the Integration Key")
            _invalidate_api_key_cache()
            continue
        break
    return response


def delete_viewer_key(key_id: str) -> None:
    """Delete one viewer key from the Miris workspace.

    A key Miris no longer has (404) counts as deleted. Raises `MirisIntegrationError` for an ID
    that is not a UUID (without calling Miris), for any other non-2xx status, and for a transport
    failure.
    """
    if not is_viewer_key_id(key_id):
        raise MirisIntegrationError("Viewer key ID is not a UUID")
    response = _request("DELETE", f"/v1/asset-viewer-key/{key_id}")
    if response.status_code in (200, 204):
        return
    if response.status_code == 404:
        logger.info(f"Miris viewer key {key_id} was already deleted")
        return
    raise MirisIntegrationError(
        f"Miris viewer key delete returned HTTP {response.status_code}",
        status_code=response.status_code,
    )
