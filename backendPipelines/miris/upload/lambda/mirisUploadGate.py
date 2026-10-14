#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
"""
Miris Upload Gate Lambda.

A fileUpload trigger fires once per uploaded file, so a multi-file USD asset fans out to one
execution per matching layer — each of which would package the same dependency graph and create a
duplicate Miris asset. This gate collapses that fan-out to a single upload.

The claim is an S3 conditional put (``If-None-Match: *``) at a key derived only from the asset and
its current version (``mirisClaim.claim_location``), so every execution fanned out from one upload
computes the same key. Exactly one caller can create the object; every other caller receives
``PreconditionFailed`` and exits as a no-op success, reporting against its own task token so the
workflow task does not wait out its timeout.

A claim that is not followed by a successful upload is released again by ``pipelineEnd`` (or by the
lambda that detected the failure), so a failed run does not leave the asset version permanently
skipped.

The claim records its owner, a digest of the execution's workflow task token. A retried put whose
first attempt landed but whose response was lost meets the caller's OWN claim and fails with
``PreconditionFailed``; reading the owner back tells that apart from another execution's claim, which
would otherwise skip the upload and strand a claim that nothing releases.

Per-database scoping is NOT handled here: a database-scoped trigger fires only for uploads in its
own database, which VAMS resolves natively during trigger matching.
"""
import hashlib
import json
import os

import boto3
from botocore.config import Config
from customLogging.logger import safeLogger

from mirisClaim import claim_location

logger = safeLogger(service="MirisUploadGate")
retry_config = Config(retries={"max_attempts": 5, "mode": "adaptive"})
s3_client = boto3.client("s3", region_name=os.environ.get("AWS_REGION"), config=retry_config)
sfn_client = boto3.client("stepfunctions", region_name=os.environ.get("AWS_REGION"), config=retry_config)


def _parse_body(event):
    body = event.get("body", event)
    if isinstance(body, str):
        body = json.loads(body)
    return body


def _owner_id(task_token):
    """Claim owner for this execution: stable across retries of this lambda, unique per fan-out.

    A digest rather than the token itself, since the token can complete the workflow task.
    """
    if not task_token:
        return ""
    return hashlib.sha256(task_token.encode("utf-8")).hexdigest()


def _claim_is_ours(bucket, key, owner):
    """Whether the claim already at `key` was written by this execution.

    Anything unverifiable (no owner to compare, a claim that has since been released, a claim
    written before claims recorded an owner, an unreadable body) is treated as another execution's.
    """
    if not owner:
        return False
    try:
        existing = json.loads(s3_client.get_object(Bucket=bucket, Key=key)["Body"].read())
    except (s3_client.exceptions.ClientError, ValueError) as e:
        logger.info(f"Could not confirm claim ownership, treating it as held elsewhere: {e}")
        return False
    return isinstance(existing, dict) and existing.get("owner") == owner


def _report_skipped(task_token, reason):
    if not task_token:
        return
    try:
        sfn_client.send_task_success(
            taskToken=task_token,
            output=json.dumps({"status": "skipped", "reason": reason}),
        )
    except Exception as e:
        # Best-effort: returning gate=skip still short-circuits vamsExecute. If the token call
        # genuinely failed the workflow task falls back to its timeout.
        logger.warning(f"send_task_success failed (will fall through): {e}")


def lambda_handler(event, context):
    logger.info("MirisUploadGate received event")
    body = _parse_body(event)
    asset_id = body.get("assetId", "")
    asset_version_id = body.get("assetVersionId", "")
    task_token = body.get("sfnExternalTaskToken", "") or ""
    owner = _owner_id(task_token)

    bucket, key = claim_location(
        body.get("inputOutputS3AssetAuxiliaryFilesPath", ""), asset_id, asset_version_id)

    # No auxiliary location means no place to record a claim. Proceed rather than block: a missing
    # dedup is a duplicate upload, whereas a false skip loses the upload entirely.
    if not bucket:
        logger.warning("No auxiliary path available for the claim; proceeding without dedup")
        return {"gate": "proceed"}

    try:
        s3_client.put_object(
            Bucket=bucket,
            Key=key,
            Body=json.dumps({
                "assetId": asset_id,
                "assetVersionId": asset_version_id,
                "mirisAssetName": body.get("mirisAssetName", ""),
                "owner": owner,
            }).encode("utf-8"),
            IfNoneMatch="*",
        )
    except s3_client.exceptions.ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("PreconditionFailed", "ConditionalRequestConflict"):
            if _claim_is_ours(bucket, key, owner):
                logger.info(f"Claim s3://{bucket}/{key} already held by this execution; proceeding")
                return {"gate": "proceed"}
            reason = (f"Miris upload for asset {asset_id!r} version "
                      f"{asset_version_id or 'live'!r} is already claimed by another execution")
            logger.info(f"Skipping: {reason}")
            _report_skipped(task_token, reason)
            return {"gate": "skip", "reason": reason}
        raise

    logger.info(f"Claimed s3://{bucket}/{key}")
    return {"gate": "proceed"}
