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

import manifestHelper
import mirisClaim

logger = safeLogger(service="VamsExecuteMirisUpload")
lambda_client = boto3.client("lambda")
s3_client = boto3.client("s3")
sfn_client = boto3.client("stepfunctions", region_name=os.environ.get("AWS_REGION", "us-east-1"))
dynamodb = boto3.resource("dynamodb")

OPEN_PIPELINE_FUNCTION_NAME = os.environ["OPEN_PIPELINE_FUNCTION_NAME"]
MIRIS_UPLOAD_GATE_FUNCTION_NAME = os.environ.get("MIRIS_UPLOAD_GATE_FUNCTION_NAME", "")
ASSET_STORAGE_TABLE_NAME = os.environ.get("ASSET_STORAGE_TABLE_NAME", "")


def _asset_table():
    """The asset storage table resource. Wrapped so tests can patch it."""
    return dynamodb.Table(ASSET_STORAGE_TABLE_NAME)


def resolve_asset_identity(database_id, asset_id):
    """The asset's display name and current version id.

    The workflow manifest carries asset IDs but no asset NAME, so the Miris asset name is read
    here rather than rendered from a template tag. `currentVersionId` is read from the same
    record and becomes the gate's claim key: every execution fanned out from one upload sees the
    same value, which is what makes the claim collapse them.
    """
    if not (ASSET_STORAGE_TABLE_NAME and database_id and asset_id):
        return "", ""
    try:
        item = _asset_table().get_item(
            Key={"databaseId": database_id, "assetId": asset_id}
        ).get("Item") or {}
    except Exception as e:
        logger.warning(f"Could not read asset record {database_id}/{asset_id}: {e}")
        return "", ""
    return item.get("assetName", "") or "", item.get("currentVersionId", "") or ""


def abort_external_workflow(error, task_token):
    """Fail the workflow's waitForCallback token so the task does not wait out its taskTimeout."""
    if not task_token:
        return
    try:
        sfn_client.send_task_failure(
            taskToken=task_token,
            error="MirisUploadError",
            cause=str(error)[:256],
        )
        logger.info("Sent task failure callback to Step Functions")
    except Exception as e:
        logger.error(f"Failed to send task failure callback: {e}")


def invoke_gate(resolved, asset_version_id, miris_asset_name, task_token):
    """Claim the (assetId, assetVersionId) key. Returns True when this execution should proceed."""
    if not MIRIS_UPLOAD_GATE_FUNCTION_NAME:
        return True
    payload = {
        "body": json.dumps({
            "databaseId": resolved["databaseId"],
            "assetId": resolved["assetId"],
            "assetVersionId": asset_version_id,
            "mirisAssetName": miris_asset_name,
            "inputOutputS3AssetAuxiliaryFilesPath":
                resolved["inputOutputS3AssetAuxiliaryFilesPath"],
            "sfnExternalTaskToken": task_token,
        })
    }
    response = lambda_client.invoke(
        FunctionName=MIRIS_UPLOAD_GATE_FUNCTION_NAME,
        InvocationType="RequestResponse",
        Payload=json.dumps(payload).encode("utf-8"),
    )
    if response.get("FunctionError"):
        raise Exception(f"Invoke gate lambda failed: {response.get('FunctionError')}")
    result = json.loads(response["Payload"].read().decode("utf-8"))
    return result.get("gate") != "skip"


def execute_pipeline(resolved, asset_version_id, miris_asset_name, external_task_token,
                     executing_userName, executing_requestContext):
    """Invoke openMirisUploadPipeline with the full pipeline payload."""
    message_payload = {
        "inputS3AssetFilePath": resolved["inputS3AssetFilePath"],
        "outputS3AssetFilesPath": resolved["outputS3AssetFilesPath"],
        "outputS3AssetPreviewPath": resolved["outputS3AssetPreviewPath"],
        "outputS3AssetMetadataPath": resolved["outputS3AssetMetadataPath"],
        "inputOutputS3AssetAuxiliaryFilesPath": resolved["inputOutputS3AssetAuxiliaryFilesPath"],
        "inputMetadataS3Location": resolved["inputMetadataS3Location"],
        "inputConfigurationS3Location": resolved["inputConfigurationS3Location"],
        "sfnExternalTaskToken": external_task_token,
        "executingUserName": executing_userName,
        "executingRequestContext": executing_requestContext,
        "orchestrationEventPrefix": resolved["orchestrationEventPrefix"],
        "assetId": resolved["assetId"],
        "databaseId": resolved["databaseId"],
        # Carried through the whole chain so any downstream failure can release the gate's claim.
        "assetVersionId": asset_version_id,
        "mirisAssetName": miris_asset_name,
    }

    logger.info("Invoking openMirisUploadPipeline")
    response = lambda_client.invoke(
        FunctionName=OPEN_PIPELINE_FUNCTION_NAME,
        InvocationType="RequestResponse",
        Payload=json.dumps(message_payload).encode("utf-8"),
    )

    if response.get("StatusCode") != 200:
        raise Exception("Invoke openMirisUploadPipeline failed.")

    # A handled invocation still returns 200 when the invoked function raised; the failure is
    # reported via FunctionError. Without this check the workflow's callback task blocks until
    # taskTimeout.
    if response.get("FunctionError"):
        raise Exception(
            f"Invoke openMirisUploadPipeline failed: {response.get('FunctionError')}")


def lambda_handler(event, context):
    logger.info("VamsExecuteMirisUpload received event")
    external_task_token = None
    # Set once the gate has written a claim, so a later failure can release it again.
    claim = None
    try:
        body = event.get("body")
        if not body:
            return {"statusCode": 400, "body": json.dumps({"message": "Request body is required"})}
        data = json.loads(body) if isinstance(body, str) else body

        # Capture the token BEFORE resolving the manifest: a manifest that cannot be read raises,
        # and that raise must reach send_task_failure rather than leaving the task pending.
        if "TaskToken" not in data:
            raise Exception(
                "VAMS Workflow TaskToken not found in pipeline input. "
                "Make sure this pipeline is registered with waitForCallback=Enabled."
            )
        external_task_token = data["TaskToken"]

        resolved = manifestHelper.resolve_pipeline_inputs(data, s3_client)
        manifestHelper.enforce_single_input_file(resolved)
        logger.info(f"Resolved pipeline inputs (manifestUsed={resolved.get('manifestUsed')})")

        asset_name, asset_version_id = resolve_asset_identity(
            resolved["databaseId"], resolved["assetId"])

        if not invoke_gate(resolved, asset_version_id, asset_name, external_task_token):
            logger.info("Gate returned skip; this execution is a no-op")
            return {"statusCode": 200, "body": "Skipped (gate)"}

        claim = (resolved["inputOutputS3AssetAuxiliaryFilesPath"],
                 resolved["assetId"], asset_version_id)

        execute_pipeline(
            resolved,
            asset_version_id,
            asset_name,
            external_task_token,
            data.get("executingUserName", ""),
            data.get("executingRequestContext", ""),
        )
        return {"statusCode": 200, "body": "Success"}
    except Exception as e:
        logger.exception(e)
        # The claim is only released when the pipeline never got started. Leaving it behind would
        # skip this asset version on every later trigger and manual run.
        if claim:
            mirisClaim.release_claim(s3_client, logger, *claim)
        abort_external_workflow(e, external_task_token)
        return {"statusCode": 500, "body": json.dumps({"message": "Internal Server Error"})}
