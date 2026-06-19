#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
"""
Lambda Function called by VAMS workflows for Miris auto-upload execution.
Note: function name must start with "vams" to allow invoke permissioning from VAMS.
"""
import json
import os

import boto3
from customLogging.logger import safeLogger

logger = safeLogger(service="VamsExecuteMirisUpload")
lambda_client = boto3.client("lambda")
OPEN_PIPELINE_FUNCTION_NAME = os.environ["OPEN_PIPELINE_FUNCTION_NAME"]


def execute_pipeline(
    input_s3_asset_file_path,
    output_s3_asset_files_path,
    output_s3_asset_preview_path,
    output_s3_asset_metadata_path,
    inputOutput_s3_assetAuxiliary_files_path,
    input_metadata,
    input_parameters,
    external_task_token,
    executing_userName,
    executing_requestContext,
    asset_id,
    database_id,
):
    """Invoke openMirisUploadPipeline with the full pipeline payload."""
    message_payload = {
        "inputS3AssetFilePath": input_s3_asset_file_path,
        "outputS3AssetFilesPath": output_s3_asset_files_path,
        "outputS3AssetPreviewPath": output_s3_asset_preview_path,
        "outputS3AssetMetadataPath": output_s3_asset_metadata_path,
        "inputOutputS3AssetAuxiliaryFilesPath": inputOutput_s3_assetAuxiliary_files_path,
        "inputMetadata": input_metadata,
        "inputParameters": input_parameters,
        "sfnExternalTaskToken": external_task_token,
        "executingUserName": executing_userName,
        "executingRequestContext": executing_requestContext,
        "assetId": asset_id,
        "databaseId": database_id,
    }

    logger.info("Invoking openMirisUploadPipeline")
    response = lambda_client.invoke(
        FunctionName=OPEN_PIPELINE_FUNCTION_NAME,
        InvocationType="RequestResponse",
        Payload=json.dumps(message_payload).encode("utf-8"),
    )
    logger.info("openMirisUploadPipeline invocation returned")

    if response.get("StatusCode") != 200:
        msg = response.get("body", {}).get("message", "")
        raise Exception(f"Invoke openMirisUploadPipeline failed. {msg}")


def lambda_handler(event, context):
    logger.info("VamsExecuteMirisUpload received event")
    try:
        body = event.get("body")
        if not body:
            return {
                "statusCode": 400,
                "body": json.dumps({"message": "Request body is required"}),
            }
        data = json.loads(body) if isinstance(body, str) else body

        if "TaskToken" not in data:
            raise Exception(
                "VAMS Workflow TaskToken not found in pipeline input. "
                "Make sure this pipeline is registered with waitForCallback=Enabled."
            )

        # First: invoke the gate Lambda. If it returns gate=skip, we're done.
        gate_function_name = os.environ.get("MIRIS_UPLOAD_GATE_FUNCTION_NAME", "")
        if gate_function_name:
            gate_payload = {
                "body": json.dumps(
                    {
                        "databaseId": data.get("databaseId", ""),
                        "assetId": data.get("assetId", ""),
                        "inputS3AssetFilePath": data["inputS3AssetFilePath"],
                        "sfnExternalTaskToken": data["TaskToken"],
                        "inputParameters": data.get("inputParameters", ""),
                    }
                )
            }
            gate_resp = lambda_client.invoke(
                FunctionName=gate_function_name,
                InvocationType="RequestResponse",
                Payload=json.dumps(gate_payload).encode("utf-8"),
            )
            gate_result = json.loads(gate_resp["Payload"].read().decode("utf-8"))
            if gate_result.get("gate") == "skip":
                logger.info("Gate Lambda returned skip; pipeline is a no-op")
                return {"statusCode": 200, "body": "Skipped (gate)"}

        execute_pipeline(
            data["inputS3AssetFilePath"],
            data["outputS3AssetFilesPath"],
            data["outputS3AssetPreviewPath"],
            data["outputS3AssetMetadataPath"],
            data["inputOutputS3AssetAuxiliaryFilesPath"],
            data.get("inputMetadata", ""),
            data.get("inputParameters", ""),
            data["TaskToken"],
            data.get("executingUserName", ""),
            data.get("executingRequestContext", ""),
            data.get("assetId", ""),
            data.get("databaseId", ""),
        )
        return {"statusCode": 200, "body": "Success"}
    except Exception as e:
        logger.exception(e)
        return {
            "statusCode": 500,
            "body": json.dumps({"message": "Internal Server Error"}),
        }
