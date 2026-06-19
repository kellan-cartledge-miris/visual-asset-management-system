#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
"""
Miris Upload Gate Lambda.

The Miris upload workflow is auto-triggered by VAMS whenever a file with a
matching extension lands in any database. This gate enforces a per-database
allow-list before the rest of the pipeline runs, since VAMS does not have a
native per-database trigger knob.

Behavior:
  - inputParameters.manual=true   => bypass allow-list (manual UI/CLI invocations)
  - databaseId in allow-list      => proceed
  - databaseId not in allow-list  => send_task_success with status="skipped"
                                     and return {gate: "skip"}
"""
import json
import os

import boto3
from customLogging.logger import safeLogger

logger = safeLogger(service="MirisUploadGate")


def _parse_body(event):
    body = event.get("body", event)
    if isinstance(body, str):
        body = json.loads(body)
    return body


def _is_manual(input_parameters):
    if not input_parameters:
        return False
    if isinstance(input_parameters, str):
        try:
            input_parameters = json.loads(input_parameters)
        except json.JSONDecodeError:
            return False
    return bool(input_parameters.get("manual"))


def lambda_handler(event, context):
    enabled_databases = json.loads(os.environ.get("MIRIS_UPLOAD_ENABLED_DATABASES", "[]"))
    logger.info("MirisUploadGate received event")
    body = _parse_body(event)
    database_id = body.get("databaseId", "")
    task_token = body.get("sfnExternalTaskToken", "") or ""
    input_parameters = body.get("inputParameters", "")

    if _is_manual(input_parameters):
        logger.info("Manual invocation; bypassing allow-list")
        return {"gate": "proceed", "databaseId": database_id, **body}

    if database_id in enabled_databases:
        logger.info(f"Database {database_id} in allow-list; proceeding")
        return {"gate": "proceed", "databaseId": database_id, **body}

    reason = f"Database {database_id!r} not in MIRIS_UPLOAD_ENABLED_DATABASES allow-list"
    logger.info(f"Skipping: {reason}")
    if task_token:
        sfn = boto3.client("stepfunctions")
        sfn.send_task_success(
            taskToken=task_token,
            output=json.dumps({"status": "skipped", "reason": reason}),
        )
    return {"gate": "skip", "reason": reason}
