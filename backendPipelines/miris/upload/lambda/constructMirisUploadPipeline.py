#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
"""Builds the Batch job definition for the Miris upload container."""
import json
import os

from customLogging.logger import safeLogger

logger = safeLogger(service="ConstructMirisUploadPipeline")

MIRIS_API_BASE_URL = os.environ["MIRIS_API_BASE_URL"]
MIRIS_API_KEY_SECRET_ARN = os.environ["MIRIS_API_KEY_SECRET_ARN"]
MIRIS_UPLOAD_TASK_TIMEOUT_SECONDS = int(
    os.environ.get("MIRIS_UPLOAD_TASK_TIMEOUT_SECONDS", "1800")
)
MIRIS_UPLOAD_MAX_ASSET_SIZE_BYTES = int(
    os.environ.get("MIRIS_UPLOAD_MAX_ASSET_SIZE_BYTES", "5000000000")
)


def lambda_handler(event, context):
    logger.info("ConstructMirisUploadPipeline received event")

    job_name = event.get("jobName")
    input_s3_uri = event.get("inputS3AssetFilePath", "")
    aux_uri = event.get("inputOutputS3AssetAuxiliaryFilesPath", "")
    output_files_uri = event.get("outputS3AssetFilesPath", "")
    asset_id = event.get("assetId", "")
    database_id = event.get("databaseId", "")
    asset_version_id = event.get("assetVersionId", "")
    input_configuration_s3_location = event.get("inputConfigurationS3Location", "")
    miris_asset_name = event.get("mirisAssetName", "")

    aux_bucket = ""
    aux_key = ""
    if aux_uri:
        aux_bucket, aux_key = aux_uri.replace("s3://", "").split("/", 1)

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
                "databaseId": database_id,
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
                "inputConfigurationS3Location": input_configuration_s3_location,
                "mirisAssetName": miris_asset_name,
            }
        ],
        "inputMetadataS3Location": event.get("inputMetadataS3Location", ""),
        "externalSfnTaskToken": event.get("externalSfnTaskToken", ""),
    }

    return {
        "jobName": job_name,
        "currentStageType": "MIRIS_UPLOAD",
        "definition": [json.dumps(definition)],
        "inputMetadataS3Location": event.get("inputMetadataS3Location", ""),
        "externalSfnTaskToken": event.get("externalSfnTaskToken", ""),
        # The failure branch reads these off the state to release the gate's claim.
        "assetId": asset_id,
        "assetVersionId": asset_version_id,
        "inputOutputS3AssetAuxiliaryFilesPath": aux_uri,
        "status": "STARTING",
    }
