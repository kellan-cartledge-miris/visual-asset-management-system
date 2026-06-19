#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
"""Miris HTTP client for the upload pipeline.

Implements the four-call flow:
  1. POST /v1/asset                       → start_upload
  2. (caller does SigV4 S3 PUT separately)
  3. PUT  /v1/asset/upload/{asset_id}     → mark_upload_complete
  4. POST /v1/asset/{asset_id}/generate   → trigger_generate
  5. GET  /v1/asset/{asset_id}            → poll_until_streamable

Endpoints verified against Aqua production source (Phase 2 spec Section 12.1).
"""
import time
from typing import Any

import requests

# Initial state returned by trigger_generate. Subsequent polls must reach this
# terminal value (or an error state) to be considered done. If Miris changes
# their state vocabulary, update this constant.
STREAMABLE_READY_STATE = "streamable_ready"
STREAMABLE_ERROR_STATES = ("streamable_failed", "failed", "error")

_REDACTED_KEYS = ("access_key_id", "secret_key", "session_token")


def _redact_response(resp: dict) -> dict:
    """Return a copy of `resp` with secret-triple keys replaced by `<redacted>`."""
    return {k: ("<redacted>" if k in _REDACTED_KEYS else v) for k, v in resp.items()}


class MirisError(Exception):
    """Raised on any non-2xx Miris API response."""


class MirisClient:
    def __init__(self, base_url: str, integration_key: str, timeout_seconds: int = 60):
        self.base_url = base_url.rstrip("/")
        self._integration_key = integration_key
        self._timeout = timeout_seconds
        self._session = requests.Session()
        self._session.headers["Authorization"] = f"Bearer {integration_key}"
        self._session.headers["Content-Type"] = "application/json"

    # 1. POST /v1/asset
    def start_upload(
        self,
        name: str,
        content_path: str,
        total_bytes: int,
        tags: list[str],
    ) -> dict[str, Any]:
        url = f"{self.base_url}/v1/asset"
        body = {
            "name": name,
            "content_path": content_path,
            "file_count": 1,
            "input_type": "usd",
            "output_type": "static",
            "tags": tags,
            "total_bytes": total_bytes,
        }
        r = self._session.post(url, json=body, timeout=self._timeout)
        if r.status_code >= 300:
            raise MirisError(
                f"POST /v1/asset failed [{r.status_code}]: {r.text[:500]}"
            )
        return r.json()

    # 3. PUT /v1/asset/upload/{asset_id}
    def mark_upload_complete(self, asset_id: str) -> dict[str, Any]:
        url = f"{self.base_url}/v1/asset/upload/{asset_id}"
        r = self._session.put(url, json={"status": "completed"}, timeout=self._timeout)
        if r.status_code >= 300:
            raise MirisError(
                f"PUT /v1/asset/upload/{asset_id} failed [{r.status_code}]: {r.text[:500]}"
            )
        return r.json()

    # 4. POST /v1/asset/{asset_id}/generate
    def trigger_generate(self, asset_id: str) -> dict[str, Any]:
        url = f"{self.base_url}/v1/asset/{asset_id}/generate"
        # No body per Aqua source (apistructs.go:391, "requires no request body")
        r = self._session.post(url, timeout=self._timeout)
        if r.status_code >= 300:
            raise MirisError(
                f"POST /v1/asset/{asset_id}/generate failed "
                f"[{r.status_code}]: {r.text[:500]}"
            )
        return r.json()

    def get_asset(self, asset_id: str) -> dict[str, Any]:
        url = f"{self.base_url}/v1/asset/{asset_id}"
        r = self._session.get(url, timeout=self._timeout)
        if r.status_code >= 300:
            raise MirisError(
                f"GET /v1/asset/{asset_id} failed [{r.status_code}]: {r.text[:500]}"
            )
        return r.json()

    # 5. Poll
    def poll_until_streamable(
        self,
        asset_id: str,
        timeout_seconds: int,
        poll_interval_seconds: int = 10,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        last = None
        while True:
            last = self.get_asset(asset_id)
            state = last.get("state", "")
            if state == STREAMABLE_READY_STATE:
                return last
            if state in STREAMABLE_ERROR_STATES:
                raise MirisError(
                    f"Asset {asset_id} reached terminal error state {state!r}"
                )
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Asset {asset_id} did not become streamable within "
                    f"{timeout_seconds}s; last state {state!r}"
                )
            if poll_interval_seconds > 0:
                time.sleep(poll_interval_seconds)
