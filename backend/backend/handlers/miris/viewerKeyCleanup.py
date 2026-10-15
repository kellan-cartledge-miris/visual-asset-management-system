# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""DynamoDB stream consumer that deletes expired per-view Miris viewer keys.

Each per-view viewer key VAMS mints is recorded in MirisViewerKeyStorageTable under its Miris key
ID, with a `ttl` after the key's expiry. An expired key stays in the Miris workspace until it is
deleted, so when DynamoDB TTL removes the row, this handler deletes the key from Miris.

The event source mapping filters the KEYS_ONLY stream to TTL deletions: `REMOVE` records whose
`userIdentity` is the DynamoDB service. Any other record that reaches the handler is skipped.

A record whose key could not be deleted is reported in `batchItemFailures` under its
`dynamodb.SequenceNumber`, so Lambda retries from that record rather than from the start of the
batch. A key Miris no longer has counts as deleted, which keeps a retried record idempotent. A
record whose key ID is not a UUID is logged and skipped, since no retry can delete it.
"""
from typing import Any, Dict, List

from aws_lambda_powertools.utilities.typing import LambdaContext

from customLogging.logger import safeLogger

from . import mirisIntegration

logger = safeLogger(service_name="MirisViewerKeyCleanup")

_KEY_ATTRIBUTE = "mirisViewerKeyId"


def _is_ttl_removal(record: Dict[str, Any]) -> bool:
    """True for a stream record written by a DynamoDB TTL deletion."""
    identity = record.get("userIdentity") or {}
    return (
        record.get("eventName") == "REMOVE"
        and identity.get("type") == "Service"
        and identity.get("principalId") == "dynamodb.amazonaws.com"
    )


def lambda_handler(event, context: LambdaContext) -> Dict[str, List[Dict[str, str]]]:
    failures: List[Dict[str, str]] = []
    for record in event.get("Records") or []:
        if not _is_ttl_removal(record):
            continue
        stream_record = record.get("dynamodb") or {}
        sequence_number = stream_record.get("SequenceNumber")
        key_id = ((stream_record.get("Keys") or {}).get(_KEY_ATTRIBUTE) or {}).get("S")

        if not mirisIntegration.is_viewer_key_id(key_id):
            # A retry cannot repair the record, so it is skipped rather than reported.
            logger.error(
                f"Skipping stream record {sequence_number}: key ID {key_id!r:.100} is not a viewer key ID"
            )
            continue
        try:
            mirisIntegration.delete_viewer_key(key_id)
            logger.info(f"Deleted Miris viewer key {key_id}")
        except mirisIntegration.MirisIntegrationError as e:
            logger.error(f"Could not delete Miris viewer key {key_id}: {e}")
            failures.append({"itemIdentifier": sequence_number})
        except Exception as e:
            logger.error(f"Could not delete Miris viewer key {key_id} ({type(e).__name__})")
            failures.append({"itemIdentifier": sequence_number})

    return {"batchItemFailures": failures}
