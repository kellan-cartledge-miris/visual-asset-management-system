#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
"""Miris HTTP client for the upload pipeline.

Implements the production upload flow as verified against
`mcp__miris-development__GetApiReference` on 2026-06-22:

  1. POST /v1/content                  -> start_upload (returns id + temp S3 creds)
  2. (caller does the SigV4 S3 PUT to those temp creds out-of-band)
  3. PUT  /v1/content/{id}             -> mark_upload_complete (status=completed)
  4. POST /v1/asset/{id}/generate      -> trigger_generate_best_effort (optional)
  5. GET  /v1/asset/{id}               -> poll_until_terminal

Auth uses the `Miris-Integration-Key` header (NOT `Authorization: Bearer`),
matching the OpenAPI ApiKeyHeader scheme.

State machine:
  output_type="static" produces the terminal state `preview` within minutes.
  Promotion to `streamable` is a separate, hours-long, entitlement-gated step.
  The pipeline polls until `preview` (or already-`streamable`) and then makes a
  best-effort call to kick off streamable promotion; failures there are logged
  but do not fail the pipeline (manual promotion in the Miris Portal is the
  fallback).
"""
import time
from typing import Any, Optional

import requests

# Per Miris REST API reference, terminal asset states are:
#   preview, streamable, error, failed
TERMINAL_SUCCESS_STATES = ("preview", "streamable")
TERMINAL_ERROR_STATES = ("error", "failed")

_REDACTED_KEYS = ("access_key_id", "secret_key", "session_token")


def _redact_response(resp: dict) -> dict:
    """Return a copy of `resp` with secret-triple keys replaced by `<redacted>`."""
    return {k: ("<redacted>" if k in _REDACTED_KEYS else v) for k, v in resp.items()}


class MirisError(Exception):
    """Raised on any non-2xx Miris API response from a required call."""


class MirisClient:
    def __init__(self, base_url: str, integration_key: str, timeout_seconds: int = 60):
        self.base_url = base_url.rstrip("/")
        self._integration_key = integration_key
        self._timeout = timeout_seconds
        self._session = requests.Session()
        self._session.headers["Miris-Integration-Key"] = integration_key
        self._session.headers["Content-Type"] = "application/json"

    # 1. POST /v1/content
    def start_upload(
        self,
        name: str,
        content_path: str,
        total_bytes: int,
        tags: list,
    ) -> dict:
        url = f"{self.base_url}/v1/content"
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
                f"POST /v1/content failed [{r.status_code}]: {r.text[:500]}"
            )
        return r.json()

    # 3. PUT /v1/content/{id}
    def mark_upload_complete(self, content_id: str) -> Optional[dict]:
        url = f"{self.base_url}/v1/content/{content_id}"
        r = self._session.put(
            url, json={"status": "completed"}, timeout=self._timeout
        )
        if r.status_code >= 300:
            raise MirisError(
                f"PUT /v1/content/{content_id} failed "
                f"[{r.status_code}]: {r.text[:500]}"
            )
        return r.json() if r.text else None

    # 4. POST /v1/asset/{id}/generate  (best-effort; not in the public spec)
    def trigger_generate_best_effort(self, asset_id: str) -> Optional[dict]:
        """Kick off the streamable-promotion job. The endpoint is not in the
        public OpenAPI but is what the `miris asset generate` CLI command hits.
        Returns the parsed body on 2xx; returns None on any HTTP error so the
        pipeline can carry on (manual portal promotion is the fallback).
        Connection-level failures still raise."""
        url = f"{self.base_url}/v1/asset/{asset_id}/generate"
        try:
            r = self._session.post(url, timeout=self._timeout)
        except requests.RequestException as e:
            raise MirisError(
                f"POST /v1/asset/{asset_id}/generate connection failure: {e}"
            )
        if r.status_code >= 300:
            return None
        return r.json() if r.text else {}

    # 5. GET /v1/asset/{id}
    def get_asset(self, asset_id: str) -> dict:
        url = f"{self.base_url}/v1/asset/{asset_id}"
        r = self._session.get(url, timeout=self._timeout)
        if r.status_code >= 300:
            raise MirisError(
                f"GET /v1/asset/{asset_id} failed [{r.status_code}]: {r.text[:500]}"
            )
        return r.json()

    # Poll
    def poll_until_terminal(
        self,
        asset_id: str,
        timeout_seconds: int,
        poll_interval_seconds: int = 10,
    ) -> dict:
        deadline = time.monotonic() + timeout_seconds
        last: dict = {}
        while True:
            last = self.get_asset(asset_id)
            state = last.get("state", "")
            if state in TERMINAL_SUCCESS_STATES:
                return last
            if state in TERMINAL_ERROR_STATES:
                raise MirisError(
                    f"Asset {asset_id} reached terminal error state {state!r}"
                )
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Asset {asset_id} did not reach a terminal state within "
                    f"{timeout_seconds}s; last state {state!r}"
                )
            if poll_interval_seconds > 0:
                time.sleep(poll_interval_seconds)
