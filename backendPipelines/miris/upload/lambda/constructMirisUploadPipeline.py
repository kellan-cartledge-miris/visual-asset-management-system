#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
"""Builds the Batch job definition for the Miris upload container and provides
S3-lock dedup against S3 event redelivery (5 min window)."""
import hashlib
import json
import os
import time

import boto3
from customLogging.logger import safeLogger

logger = safeLogger(service="ConstructMirisUploadPipeline")
s3_client = boto3.client("s3")

MIRIS_API_BASE_URL = os.environ["MIRIS_API_BASE_URL"]
MIRIS_API_KEY_SECRET_ARN = os.environ["MIRIS_API_KEY_SECRET_ARN"]
MIRIS_UPLOAD_TASK_TIMEOUT_SECONDS = int(
    os.environ.get("MIRIS_UPLOAD_TASK_TIMEOUT_SECONDS", "1800")
)
MIRIS_UPLOAD_MAX_ASSET_SIZE_BYTES = int(
    os.environ.get("MIRIS_UPLOAD_MAX_ASSET_SIZE_BYTES", "5000000000")
)


def _is_duplicate_job(job_name, input_path, aux_bucket, aux_key, expiration_seconds=300):
    """Same S3 lock pattern as splatToolbox/constructPipeline.py."""
    job_hash = hashlib.md5(  # nosec B324 - dedup, not cryptographic
        f"{job_name}:{input_path}".encode("utf-8")
    ).hexdigest()
    lock_key = f"{aux_key}/locks/miris-upload/{job_hash}"
    try:
        resp = s3_client.head_object(Bucket=aux_bucket, Key=lock_key)
        last_modified = resp.get("LastModified")
        if last_modified and (time.time() - last_modified.timestamp() < expiration_seconds):
            return True
    except s3_client.exceptions.ClientError as e:
        if e.response["Error"]["Code"] != "404":
            logger.warning(f"Error checking lock: {e}")

    s3_client.put_object(
        Bucket=aux_bucket,
        Key=lock_key,
        Body=f"Lock created at {time.time()}",
    )
    return False


def lambda_handler(event, context):
    logger.info("ConstructMirisUploadPipeline received event")

    job_name = event.get("jobName")
    input_s3_uri = event.get("inputS3AssetFilePath", "")
    aux_uri = event.get("inputOutputS3AssetAuxiliaryFilesPath", "")
    output_files_uri = event.get("outputS3AssetFilesPath", "")
    asset_id = event.get("assetId", "")

    aux_bucket = ""
    aux_key = ""
    if aux_uri:
        aux_bucket, aux_key = aux_uri.replace("s3://", "").split("/", 1)

    if aux_bucket and aux_key and _is_duplicate_job(job_name, input_s3_uri, aux_bucket, aux_key):
        logger.warning(f"Duplicate detected for {job_name}")
        return {
            "jobName": job_name,
            "status": "DUPLICATE_DETECTED",
            "error": {
                "Error": "DuplicateJobError",
                "Cause": "Duplicate job within 5-minute window.",
            },
        }

    input_bucket, input_key = input_s3_uri.replace("s3://", "").split("/", 1)
    if output_files_uri:
        out_bucket, out_key = output_files_uri.replace("s3://", "").split("/", 1)
        if not out_key.endswith("/"):
            out_key += "/"
    else:
        out_bucket = input_bucket
        out_key = f"{os.path.dirname(input_key)}/miris-upload/"

    _, extension = os.path.splitext(input_key)

    definition = {
        "jobName": job_name,
        "stages": [
            {
                "type": "MIRIS_UPLOAD",
                "assetId": asset_id,
                "triggerInput": {
                    "bucketName": input_bucket,
                    "objectKey": input_key,
                    "fileExtension": extension,
                },
                "outputFiles": {
                    "bucketName": out_bucket,
                    "objectDir": out_key,
                },
                "temporaryFiles": {
                    "bucketName": aux_bucket,
                    "objectDir": f"{aux_key}/",
                },
                "mirisApiBaseUrl": MIRIS_API_BASE_URL,
                "mirisApiKeySecretArn": MIRIS_API_KEY_SECRET_ARN,
                "taskTimeoutSeconds": MIRIS_UPLOAD_TASK_TIMEOUT_SECONDS,
                "maxAssetSizeBytes": MIRIS_UPLOAD_MAX_ASSET_SIZE_BYTES,
            }
        ],
        "inputMetadata": event.get("inputMetadata", ""),
        "inputParameters": event.get("inputParameters", ""),
        "externalSfnTaskToken": event.get("externalSfnTaskToken", ""),
    }

    return {
        "jobName": job_name,
        "currentStageType": "MIRIS_UPLOAD",
        "definition": ["python", "-u", "__main__.py", json.dumps(definition)],
        "inputMetadata": event.get("inputMetadata", ""),
        "inputParameters": event.get("inputParameters", ""),
        "externalSfnTaskToken": event.get("externalSfnTaskToken", ""),
        "status": "STARTING",
    }
