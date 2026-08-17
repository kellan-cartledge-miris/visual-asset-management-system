#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
"""
Claim-key derivation and release for the Miris upload dedup gate.

The gate writes a claim, and several later steps have to delete the *same* object when the run
does not succeed. Both halves live here so the key can only ever be derived one way.

The key is deterministic on the asset and its version and sits at the auxiliary bucket ROOT:
``locks/miris-upload/{assetId}/{assetVersionId}.claim``. Only the BUCKET is taken from the
auxiliary URI — its prefix is scoped to the workflow execution, so folding the prefix into the
key would give every fanned-out execution a different key and defeat the dedup entirely.
"""
import os

CLAIM_PREFIX = os.environ.get("MIRIS_UPLOAD_CLAIM_PREFIX", "locks/miris-upload")


def claim_location(aux_uri, asset_id, asset_version_id):
    """(bucket, key) for this asset+version claim, or (None, None) when there is no aux path.

    The version segment falls back to 'live' so an asset with no recorded version still collapses
    its fan-out rather than skipping the claim entirely.
    """
    if not aux_uri or not asset_id:
        return None, None
    bucket = aux_uri.replace("s3://", "").partition("/")[0]
    if not bucket:
        return None, None
    version = asset_version_id or "live"
    return bucket, f"{CLAIM_PREFIX}/{asset_id}/{version}.claim"


def release_claim(s3_client, logger, aux_uri, asset_id, asset_version_id):
    """Delete the claim so a later trigger or manual run can upload this asset version again.

    Best-effort: a failed release must not mask the failure that prompted it. Returns True when
    a delete was issued.
    """
    bucket, key = claim_location(aux_uri, asset_id, asset_version_id)
    if not bucket:
        logger.info("No claim location to release")
        return False
    try:
        s3_client.delete_object(Bucket=bucket, Key=key)
        logger.info(f"Released claim s3://{bucket}/{key}")
        return True
    except Exception as e:
        logger.warning(f"Could not release claim s3://{bucket}/{key}: {e}")
        return False
