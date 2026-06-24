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
import boto3

from miris_uploader import MirisClient, _redact_response
from usd_packager import (
    compute_dependencies,
    local_download_plan,
    package_usdz,
    should_skip_packaging,
)
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


def _download_asset_folder(s3, bucket: str, asset_id: str, dest_dir: str) -> int:
    """Download every object under '{asset_id}/' into dest_dir, preserving the
    relative layout so USD relative references resolve. Returns total bytes."""
    paginator = s3.get_paginator("list_objects_v2")
    keys = []
    for page in paginator.paginate(Bucket=bucket, Prefix=f"{asset_id}/"):
        for obj in page.get("Contents", []):
            keys.append(obj["Key"])
    total = 0
    for key, rel in local_download_plan(keys, asset_id):
        local = os.path.join(dest_dir, rel)
        os.makedirs(os.path.dirname(local), exist_ok=True)
        s3.download_file(bucket, key, local)
        total += os.path.getsize(local)
    return total


def main():
    if len(sys.argv) < 2:
        _log("usage: __main__.py <definition-json>")
        sys.exit(2)
    definition = json.loads(sys.argv[1])
    stage = definition["stages"][0]
    asset_id = stage["assetId"]
    # databaseId added in a later iteration; tolerate older pipeline definitions
    # that don't include it by defaulting to "".
    database_id = stage.get("databaseId", "")
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

    s3 = boto3.client("s3")
    os.makedirs("/workdir", exist_ok=True)
    name_no_ext = os.path.splitext(filename)[0]

    # Resolve the single self-contained artifact to upload to Miris.
    if extension == ".usdz":
        # Already a self-contained package — upload as-is.
        head = s3.head_object(Bucket=trigger_bucket, Key=trigger_key)
        if int(head["ContentLength"]) > max_bytes:
            _log("file_too_large", size=int(head["ContentLength"]), max_bytes=max_bytes)
            sys.exit(4)
        upload_local = f"/workdir/{filename}"
        s3.download_file(trigger_bucket, trigger_key, upload_local)
        upload_filename = filename
        upload_content_type = _USD_MEDIA_TYPES[".usdz"]
    else:
        # Text/binary USD root: download the whole asset folder, resolve deps.
        asset_dir = "/workdir/asset"
        total = _download_asset_folder(s3, trigger_bucket, asset_id, asset_dir)
        if total > max_bytes:
            _log("file_too_large", size=total, max_bytes=max_bytes)
            sys.exit(4)
        root_rel = trigger_key.split(f"{asset_id}/", 1)[1]
        root_local = os.path.join(asset_dir, root_rel)
        layers, assets, unresolved = compute_dependencies(root_local)
        if unresolved:
            _log("unresolved_references", count=len(unresolved), paths=unresolved[:20])
            sys.exit(5)
        if should_skip_packaging(len(layers), len(assets)):
            _log("packaging_skipped", reason="no_external_dependencies")
            upload_local = root_local
            upload_filename = filename
            upload_content_type = _USD_MEDIA_TYPES[extension]
        else:
            upload_local = f"/workdir/{name_no_ext}.usdz"
            package_usdz(root_local, upload_local)
            upload_filename = f"{name_no_ext}.usdz"
            upload_content_type = _USD_MEDIA_TYPES[".usdz"]
            _log(
                "packaged_usdz",
                file=upload_filename,
                layers=len(layers),
                assets=len(assets),
            )

    size = os.path.getsize(upload_local)
    sha = _sha256_of_file(upload_local)
    _log("artifact_ready", path=upload_local, size=size, sha256=sha[:16])

    # Secrets Manager
    key = get_miris_integration_key(secret_arn, region_name=os.environ.get("AWS_REGION"))
    client = MirisClient(miris_base, key)

    # POST /v1/content
    miris_tags = ["vams", f"vams-asset-{asset_id}"]
    if database_id:
        miris_tags.append(f"vams-database-{database_id}")
    start = client.start_upload(
        name=name_no_ext,
        content_path=upload_filename,
        total_bytes=size,
        tags=miris_tags,
    )
    _log("start_upload", resp=_redact_response(start))
    asset_uuid = start["id"]

    # SigV4 S3 PUT to the temp endpoint.
    # The object key MUST match the declared content_path verbatim — Miris resolves
    # the asset's materials/textures by content_path, so a percent-encoded key
    # (e.g. "Coral%20House.usdz" for content_path "Coral House.usdz") makes Miris
    # extract geometry but silently drop materials (renders flat/untextured).
    # boto3 handles wire-level encoding; the logical Key stays raw.
    temp_bucket, temp_prefix = _stripped_upload_path(start["upload_path"])
    temp_key = f"{temp_prefix}/{upload_filename}"

    temp_s3 = boto3.client(
        "s3",
        endpoint_url=start["endpoint_url"],
        region_name=start["region"],
        aws_access_key_id=start["access_key_id"],
        aws_secret_access_key=start["secret_key"],
        aws_session_token=start["session_token"],
    )
    with open(upload_local, "rb") as f:
        temp_s3.put_object(
            Bucket=temp_bucket,
            Key=temp_key,
            Body=f,
            ContentType=upload_content_type,
        )
    _log("sigv4_put_complete", bucket=temp_bucket, key=temp_key)

    # 6. PUT /v1/content/{id}
    client.mark_upload_complete(asset_uuid)
    _log("upload_marked_complete", asset_uuid=asset_uuid)

    # 7. Poll until terminal preview/streamable state
    ready = client.poll_until_terminal(asset_uuid, timeout_seconds=task_timeout)
    _log("terminal_state_reached", state=ready.get("state"))

    # 8. Best-effort streamable promotion (non-fatal; manual portal click is the fallback)
    gen = client.trigger_generate_best_effort(asset_uuid)
    if gen is None:
        _log("generate_skipped", reason="endpoint_unavailable_or_4xx")
    else:
        _log("generate_triggered", state=gen.get("state"))

    # 9. Write the .mrx manifest
    manifest_tags = ["vams", f"vams-asset-{asset_id}", "vams-pipeline"]
    if database_id:
        manifest_tags.append(f"vams-database-{database_id}")
    manifest = {
        "schemaVersion": 1,
        "mirisAssetUuid": asset_uuid,
        "displayName": name_no_ext,
        "tags": manifest_tags,
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
