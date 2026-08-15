#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
"""Step Functions Task Token callback. Reports back to the outer VAMS workflow.

A run that does not succeed also releases the dedup claim the gate wrote, so the asset version is
eligible again for the next trigger or a manual Automation run. A successful run keeps its claim:
that record is what collapses the per-file trigger fan-out.
"""
import json
import os

import boto3
from customLogging.logger import safeLogger

import mirisClaim

logger = safeLogger(service="MirisUploadPipelineEnd")
sfn = boto3.client("stepfunctions", region_name=os.environ["AWS_REGION"])
s3_client = boto3.client("s3", region_name=os.environ["AWS_REGION"])


def lambda_handler(event, context):
    logger.info("MirisUploadPipelineEnd received event")
    task_token = event.get("externalSfnTaskToken") or event.get("ExternalSfnTaskToken")
    status = event.get("status", "success")

    if status != "success":
        mirisClaim.release_claim(
            s3_client,
            logger,
            event.get("inputOutputS3AssetAuxiliaryFilesPath", ""),
            event.get("assetId", ""),
            event.get("assetVersionId", ""),
        )

    if not task_token:
        logger.warning("No external task token in event; nothing to call back to")
        return {"statusCode": 200, "body": "no-op"}

    if status == "success":
        sfn.send_task_success(
            taskToken=task_token,
            output=json.dumps(
                {
                    "status": "success",
                    "mirisAssetUuid": event.get("mirisAssetUuid", ""),
                }
            ),
        )
    else:
        sfn.send_task_failure(
            taskToken=task_token,
            error=event.get("error", "MirisUploadPipelineFailed"),
            cause=str(event.get("cause", "See container logs."))[:256],
        )

    return {"statusCode": 200, "body": "ok"}
