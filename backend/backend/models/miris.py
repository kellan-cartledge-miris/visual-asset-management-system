# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Pydantic v1 models for the Miris stream status endpoint.

    GET /database/{databaseId}/assets/{assetId}/miris/asset-status?filePath=...
"""

from typing import Optional

from pydantic import Field, validator

from aws_lambda_powertools.utilities.parser import BaseModel  # noqa: F401
try:  # pragma: no cover — runtime-dependent branch
    from aws_lambda_powertools.utilities.parser import root_validator
except ImportError:  # pragma: no cover
    from pydantic import root_validator  # type: ignore[assignment]

from common.validators import validate, trim_name
from models.metadata import MAX_FILE_PATH_LENGTH

# File-metadata keys that describe the Miris stream recorded on a USD file.
MIRIS_ASSET_UUID_KEY = "miris_asset_uuid"
MIRIS_SOURCE_VERSION_ID_KEY = "miris_source_version_id"
MIRIS_UPLOADED_AT_KEY = "miris_uploaded_at"
MIRIS_DISPLAY_NAME_KEY = "miris_display_name"

MIRIS_STREAM_METADATA_KEYS = (
    MIRIS_ASSET_UUID_KEY,
    MIRIS_SOURCE_VERSION_ID_KEY,
    MIRIS_UPLOADED_AT_KEY,
    MIRIS_DISPLAY_NAME_KEY,
)

# States the endpoint reports itself; any other value is a Miris processing state.
STATE_NOT_STREAMED = "notStreamed"
STATE_INVALID_UUID = "invalidUuid"
STATE_UNKNOWN = "unknown"


class GetMirisAssetStatusRequestModel(BaseModel, extra="ignore"):
    """Path and query parameters of the status request.

    ``filePath`` is normalized the same way the file-metadata API normalizes it, so both
    ``scene.usd`` and ``/scene.usd`` (and the ``/{assetId}/scene.usd`` form the web derives
    from S3 keys) address the same metadata row.
    """

    databaseId: str = Field(min_length=1, max_length=256)
    assetId: str = Field(min_length=1, max_length=256)
    # Not trimmed: a trailing space is a legitimate character in an asset-relative path.
    filePath: str = Field(min_length=1, max_length=MAX_FILE_PATH_LENGTH)

    _trim_ids = validator("databaseId", "assetId", pre=True, allow_reuse=True)(trim_name)

    @root_validator(skip_on_failure=True)
    def _validate_fields(cls, values):  # noqa: N805 — pydantic signature
        file_path = values.get("filePath", "")
        if not file_path.startswith("/"):
            file_path = "/" + file_path

        (valid, message) = validate(
            {
                "databaseId": {"value": values.get("databaseId"), "validator": "ID"},
                "assetId": {"value": values.get("assetId"), "validator": "ASSET_ID"},
                "filePath": {"value": file_path, "validator": "RELATIVE_FILE_PATH"},
            }
        )
        if not valid:
            raise ValueError(message)

        if file_path.endswith("/"):
            raise ValueError("filePath cannot be a folder (must not end with /)")

        asset_prefix = f"/{values.get('assetId')}/"
        if file_path.startswith(asset_prefix):
            file_path = file_path[len(asset_prefix) - 1:]

        values["filePath"] = file_path
        return values


class MirisAssetStatusResponseModel(BaseModel):
    """Stream metadata recorded on the file, plus the stream's state."""

    filePath: str
    mirisAssetUuid: Optional[str] = None
    sourceVersionId: Optional[str] = None
    uploadedAt: Optional[str] = None
    displayName: Optional[str] = None
    state: str
