#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
"""Start the inner Step Functions state machine for Miris upload processing."""
import datetime
import json
import os

import boto3
from customLogging.logger import safeLogger

logger = safeLogger(service="OpenMirisUploadPipeline")

sfn = boto3.client("stepfunctions", region_name=os.environ["AWS_REGION"])

STATE_MACHINE_ARN = os.environ["STATE_MACHINE_ARN"]
ALLOWED_INPUT_FILEEXTENSIONS = os.environ["ALLOWED_INPUT_FILEEXTENSIONS"]


def _abort_external_workflow(error, task_token):
    if task_token:
        logger.error(f"Aborting external task: {task_token}")
        sfn.send_task_failure(
            taskToken=task_token,
            error="Pipeline Failure: " + error,
            cause="See AWS CloudWatch logs for error cause.",
        )


def lambda_handler(event, context):
    logger.info("OpenMirisUploadPipeline received event")

    input_metadata = event.get("inputMetadata", "")
    input_parameters = event.get("inputParameters", "")
    external_task_token = event.get("sfnExternalTaskToken", "")
    input_s3_uri = event["inputS3AssetFilePath"]
    output_s3_files = event.get("outputS3AssetFilesPath", "")
    output_s3_preview = event.get("outputS3AssetPreviewPath", "")
    output_s3_metadata = event.get("outputS3AssetMetadataPath", "")
    aux_s3 = event["inputOutputS3AssetAuxiliaryFilesPath"]
    asset_id = event.get("assetId", "")
    database_id = event.get("databaseId", "")

    if input_s3_uri.endswith("/"):
        _abort_external_workflow(
            "Input S3 URI cannot be a folder for this pipeline", external_task_token
        )
        return {"statusCode": 400, "body": "Input S3 URI cannot be a folder"}

    _, extension = os.path.splitext(input_s3_uri)
    if (
        not extension
        or extension.lower() not in ALLOWED_INPUT_FILEEXTENSIONS.lower()
    ):
        _abort_external_workflow(
            f"Pipeline cannot process file extension {extension!r}",
            external_task_token,
        )
        return {"statusCode": 400, "body": f"Unsupported extension {extension!r}"}

    job_name = f"MirisUpload_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"

    sfn_input = {
        "jobName": job_name,
        "inputS3AssetFilePath": input_s3_uri,
        "outputS3AssetFilesPath": output_s3_files,
        "outputS3AssetPreviewPath": output_s3_preview,
        "outputS3AssetMetadataPath": output_s3_metadata,
        "inputOutputS3AssetAuxiliaryFilesPath": aux_s3,
        "inputMetadata": input_metadata,
        "inputParameters": input_parameters,
        "externalSfnTaskToken": external_task_token,
        "assetId": asset_id,
        "databaseId": database_id,
    }

    try:
        logger.info(f"Starting SFN: {STATE_MACHINE_ARN}")
        response = sfn.start_execution(
            stateMachineArn=STATE_MACHINE_ARN,
            name=job_name,
            input=json.dumps(sfn_input),
        )
        response["startDate"] = response["startDate"].strftime("%m-%d-%Y %H:%M:%S")
        return {"statusCode": 200, "body": {"message": "Started", "execution": response}}
    except Exception as e:
        logger.exception(e)
        _abort_external_workflow("Internal Server Error", external_task_token)
        return {"statusCode": 500, "body": "Internal Server Error"}
