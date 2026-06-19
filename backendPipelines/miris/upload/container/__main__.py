#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
"""Miris upload pipeline container entry point.

Reads the pipeline definition (single JSON arg from constructMirisUploadPipeline),
runs the 6-step Miris upload flow, writes the .mrx manifest, and exits 0/non-0.
"""
import datetime
import hashlib
import json
import os
import sys
import urllib.parse

import boto3

from miris_uploader import MirisClient, _redact_response
from utils.secrets import get_miris_integration_key

_USD_MEDIA_TYPES = {
    ".usd": "model/vnd.usd",
    ".usda": "model/vnd.usda",
    ".usdc": "model/vnd.usdc",
    ".usdz": "model/vnd.usdz+zip",
}


def _log(msg, **fields):
    """One-line JSON-ish log so CloudWatch keeps it together."""
    payload = {"msg": msg, **fields}
    print(json.dumps(payload, default=str), flush=True)


def _sha256_of_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _relative_subdir(trigger_object_key: str, asset_id: str) -> str:
    """Compute the relative subdir between assetId/ and the trigger file's basename,
    per VAMS Rule on pipeline state. Returns '' if the file is at asset root."""
    parts = trigger_object_key.split("/")
    try:
        idx = parts.index(asset_id)
    except ValueError:
        return ""
    return "/".join(parts[idx + 1 : -1])


def _stripped_upload_path(upload_path: str) -> tuple[str, str]:
    """Parse 's3://bucket/prefix' → ('bucket', 'prefix') (no trailing /)."""
    assert upload_path.startswith("s3://"), upload_path
    rest = upload_path[5:]
    bucket, _, prefix = rest.partition("/")
    return bucket, prefix.rstrip("/")


def main():
    if len(sys.argv) < 2:
        _log("usage: __main__.py <definition-json>")
        sys.exit(2)
    definition = json.loads(sys.argv[1])
    stage = definition["stages"][0]
    asset_id = stage["assetId"]
    trigger = stage["triggerInput"]
    output_files = stage["outputFiles"]
    miris_base = stage["mirisApiBaseUrl"]
    secret_arn = stage["mirisApiKeySecretArn"]
    task_timeout = int(stage["taskTimeoutSeconds"])
    max_bytes = int(stage["maxAssetSizeBytes"])

    trigger_bucket = trigger["bucketName"]
    trigger_key = trigger["objectKey"]
    extension = trigger["fileExtension"].lower()
    if extension not in _USD_MEDIA_TYPES:
        _log("unsupported_extension", extension=extension)
        sys.exit(3)
    filename = os.path.basename(trigger_key)
    content_type = _USD_MEDIA_TYPES[extension]

    s3 = boto3.client("s3")

    # 1. Size pre-check
    head = s3.head_object(Bucket=trigger_bucket, Key=trigger_key)
    size = int(head["ContentLength"])
    if size > max_bytes:
        _log("file_too_large", size=size, max_bytes=max_bytes)
        sys.exit(4)

    # 2. Download the single trigger file
    local_path = f"/workdir/{filename}"
    os.makedirs("/workdir", exist_ok=True)
    s3.download_file(trigger_bucket, trigger_key, local_path)
    sha = _sha256_of_file(local_path)
    _log("downloaded", path=local_path, size=size, sha256=sha[:16])

    # 3. Secrets Manager
    key = get_miris_integration_key(secret_arn, region_name=os.environ.get("AWS_REGION"))
    client = MirisClient(miris_base, key)

    # 4. POST /v1/asset
    name_no_ext = os.path.splitext(filename)[0]
    start = client.start_upload(
        name=name_no_ext,
        content_path=filename,
        total_bytes=size,
        tags=["vams", f"vams-asset-{asset_id}"],
    )
    _log("start_upload", resp=_redact_response(start))
    asset_uuid = start["id"]

    # 5. SigV4 S3 PUT to the temp endpoint
    temp_bucket, temp_prefix = _stripped_upload_path(start["upload_path"])
    encoded_name = urllib.parse.quote(filename, safe="")
    temp_key = f"{temp_prefix}/{encoded_name}"

    temp_s3 = boto3.client(
        "s3",
        endpoint_url=start["endpoint_url"],
        region_name=start["region"],
        aws_access_key_id=start["access_key_id"],
        aws_secret_access_key=start["secret_key"],
        aws_session_token=start["session_token"],
    )
    with open(local_path, "rb") as f:
        temp_s3.put_object(
            Bucket=temp_bucket,
            Key=temp_key,
            Body=f,
            ContentType=content_type,
        )
    _log("sigv4_put_complete", bucket=temp_bucket, key=temp_key)

    # 6. PUT /v1/asset/upload/{id}
    client.mark_upload_complete(asset_uuid)
    _log("upload_marked_complete", asset_uuid=asset_uuid)

    # 7. POST /v1/asset/{id}/generate
    gen = client.trigger_generate(asset_uuid)
    _log("generate_triggered", state=gen.get("state"))

    # 8. Poll
    ready = client.poll_until_streamable(asset_uuid, timeout_seconds=task_timeout)
    _log("streamable_ready", state=ready.get("state"))

    # 9. Write the .mrx manifest
    manifest = {
        "schemaVersion": 1,
        "mirisAssetUuid": asset_uuid,
        "displayName": name_no_ext,
        "tags": ["vams", f"vams-asset-{asset_id}", "vams-pipeline"],
        "uploadedAt": datetime.datetime.utcnow()
        .replace(microsecond=0)
        .isoformat()
        + "Z",
        "uploadedBy": "vams-miris-upload-pipeline",
    }
    rel_subdir = _relative_subdir(trigger_key, asset_id)
    mrx_filename = f"{filename}.mrx"
    out_key = (
        f"{output_files['objectDir']}{rel_subdir}/{mrx_filename}"
        if rel_subdir
        else f"{output_files['objectDir']}{mrx_filename}"
    )
    s3.put_object(
        Bucket=output_files["bucketName"],
        Key=out_key,
        Body=json.dumps(manifest, indent=2).encode("utf-8"),
        ContentType="application/json",
    )
    _log(
        "manifest_written",
        bucket=output_files["bucketName"],
        key=out_key,
        asset_uuid=asset_uuid,
    )


if __name__ == "__main__":
    main()
