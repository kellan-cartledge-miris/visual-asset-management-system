#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
import datetime
import importlib.util
import json
import os
import sys
import types
from unittest.mock import MagicMock, mock_open

import pytest

_CONTAINER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, _CONTAINER_DIR)

from stream_metadata import (  # noqa: E402
    build_stream_metadata_body,
    format_uploaded_at,
    metadata_object_key,
    metadata_output_location,
    relative_subdir,
)

ASSET_ID = "x86487e0b-9f50-4b7b-9b59-8963c6791b56"
METADATA_PREFIX = "pipelines/miris/job/output/E1/metadata/"
UPLOADED_AT = datetime.datetime(2026, 10, 14, 9, 30, 15, 123456, tzinfo=datetime.timezone.utc)


def _body(**overrides):
    kwargs = {
        "asset_uuid": "0b6f4c9e-6a43-4bb5-9d0c-4b3e2b1f7a10",
        "source_version_id": "3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY",
        "display_name": "Pump Housing",
        "uploaded_at": UPLOADED_AT,
    }
    kwargs.update(overrides)
    return build_stream_metadata_body(**kwargs)


def _entries(body):
    return {item["metadataKey"]: item for item in body["metadata"]}


# --- body -------------------------------------------------------------------------------------


def test_body_is_a_file_metadata_upsert():
    body = _body()

    assert body["type"] == "metadata"
    assert body["updateType"] == "update"


def test_body_carries_exactly_the_four_stream_keys():
    assert set(_entries(_body())) == {
        "miris_asset_uuid",
        "miris_source_version_id",
        "miris_uploaded_at",
        "miris_display_name",
    }
    assert len(_body()["metadata"]) == 4


def test_body_values_and_value_types():
    entries = _entries(_body())

    assert entries["miris_asset_uuid"] == {
        "metadataKey": "miris_asset_uuid",
        "metadataValue": "0b6f4c9e-6a43-4bb5-9d0c-4b3e2b1f7a10",
        "metadataValueType": "string",
    }
    assert entries["miris_source_version_id"]["metadataValue"] == "3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY"
    assert entries["miris_source_version_id"]["metadataValueType"] == "string"
    assert entries["miris_uploaded_at"]["metadataValue"] == "2026-10-14T09:30:15Z"
    assert entries["miris_uploaded_at"]["metadataValueType"] == "date"
    assert entries["miris_display_name"]["metadataValue"] == "Pump Housing"
    assert entries["miris_display_name"]["metadataValueType"] == "string"


def test_uploaded_at_parses_the_way_the_vams_date_validator_parses_it():
    value = _entries(_body())["miris_uploaded_at"]["metadataValue"]

    assert datetime.datetime.fromisoformat(value.replace("Z", "+00:00")) == UPLOADED_AT.replace(
        microsecond=0
    )


def test_uploaded_at_is_rendered_in_utc():
    plus_two = datetime.timezone(datetime.timedelta(hours=2))

    assert format_uploaded_at(datetime.datetime(2026, 10, 14, 11, 30, tzinfo=plus_two)) == (
        "2026-10-14T09:30:00Z"
    )


@pytest.mark.parametrize("version_id", [None, ""])
def test_unknown_source_version_is_written_as_empty_string(version_id):
    entry = _entries(_body(source_version_id=version_id))["miris_source_version_id"]

    assert entry["metadataValue"] == ""


def test_body_is_json_serializable():
    assert json.loads(json.dumps(_body())) == _body()


# --- object key -------------------------------------------------------------------------------


def test_relative_subdir_of_a_root_file_is_empty():
    assert relative_subdir(f"{ASSET_ID}/model.usd", ASSET_ID) == ""


def test_relative_subdir_of_a_nested_file():
    assert relative_subdir(f"{ASSET_ID}/scenes/v2/model.usd", ASSET_ID) == "scenes/v2"


def test_metadata_key_for_a_root_usd():
    assert metadata_object_key(METADATA_PREFIX, f"{ASSET_ID}/model.usda", ASSET_ID) == (
        f"{METADATA_PREFIX}model.usda.metadata.json"
    )


def test_metadata_key_for_a_nested_usd():
    assert metadata_object_key(METADATA_PREFIX, f"{ASSET_ID}/scenes/v2/model.usd", ASSET_ID) == (
        f"{METADATA_PREFIX}scenes/v2/model.usd.metadata.json"
    )


def test_metadata_key_keeps_spaces_in_the_file_name_verbatim():
    assert metadata_object_key(METADATA_PREFIX, f"{ASSET_ID}/Coral House.usdz", ASSET_ID) == (
        f"{METADATA_PREFIX}Coral House.usdz.metadata.json"
    )


# --- metadata output location -----------------------------------------------------------------


def test_metadata_output_location_reads_the_stage():
    stage = {"outputMetadataFiles": {"bucketName": "b", "objectDir": METADATA_PREFIX}}

    assert metadata_output_location(stage) == ("b", METADATA_PREFIX)


def test_metadata_output_location_normalizes_the_prefix_to_a_folder():
    stage = {"outputMetadataFiles": {"bucketName": "b", "objectDir": METADATA_PREFIX.rstrip("/")}}

    assert metadata_output_location(stage) == ("b", METADATA_PREFIX)


@pytest.mark.parametrize(
    "stage",
    [
        {},
        {"outputMetadataFiles": {}},
        {"outputMetadataFiles": {"bucketName": "b", "objectDir": ""}},
        {"outputMetadataFiles": {"bucketName": "", "objectDir": METADATA_PREFIX}},
    ],
)
def test_metadata_output_location_rejects_a_missing_path(stage):
    with pytest.raises(ValueError, match="metadata output path"):
        metadata_output_location(stage)


# --- container entry point --------------------------------------------------------------------


def _load_main():
    spec = importlib.util.spec_from_file_location(
        "miris_upload_container_main", os.path.join(_CONTAINER_DIR, "__main__.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _definition(trigger_key, **stage_overrides):
    stage = {
        "type": "MIRIS_UPLOAD",
        "assetId": ASSET_ID,
        "databaseId": "db1",
        "triggerInput": {
            "bucketName": "asset-bucket",
            "objectKey": trigger_key,
            "fileExtension": os.path.splitext(trigger_key)[1],
        },
        "outputMetadataFiles": {"bucketName": "asset-bucket", "objectDir": METADATA_PREFIX},
        "temporaryFiles": {"bucketName": "aux", "objectDir": "tmp/"},
        "mirisApiBaseUrl": "https://api.example.test",
        "mirisApiKeySecretArn": "arn:aws:secretsmanager:::secret:x",
        "taskTimeoutSeconds": 60,
        "maxAssetSizeBytes": 1000,
    }
    stage.update(stage_overrides)
    return json.dumps({"jobName": "job-1", "stages": [stage]})


@pytest.fixture
def container(monkeypatch):
    """The entry point with S3, Secrets Manager, Miris and the /workdir filesystem faked."""
    main_mod = _load_main()

    s3 = MagicMock(name="s3")
    s3.head_object.return_value = {"ContentLength": 10, "VersionId": "v-downloaded"}
    temp_s3 = MagicMock(name="temp_s3")
    fake_boto3 = MagicMock()
    fake_boto3.client.side_effect = lambda *a, **kw: temp_s3 if "endpoint_url" in kw else s3
    monkeypatch.setattr(main_mod, "boto3", fake_boto3)

    miris = MagicMock(name="miris")
    miris.start_upload.return_value = {
        "id": "0b6f4c9e-6a43-4bb5-9d0c-4b3e2b1f7a10",
        "upload_path": "s3://miris-temp/prefix",
        "endpoint_url": "https://s3.example.test",
        "region": "us-east-1",
        "access_key_id": "a",
        "secret_key": "s",
        "session_token": "t",
    }
    miris.poll_until_terminal.return_value = {"state": "streamable"}
    miris.trigger_generate_best_effort.return_value = None
    miris_cls = MagicMock(return_value=miris)
    monkeypatch.setattr(main_mod, "MirisClient", miris_cls)
    monkeypatch.setattr(main_mod, "get_miris_integration_key", lambda *a, **kw: "key")
    monkeypatch.setattr(
        main_mod,
        "resolve_upload_config",
        lambda *a, **kw: types.SimpleNamespace(asset_name="Pump Housing", tags=[]),
    )
    monkeypatch.setattr(main_mod, "_sha256_of_file", lambda path: "0" * 64)
    monkeypatch.setattr(main_mod, "open", mock_open(read_data=b"usdz"), raising=False)
    fake_path = types.SimpleNamespace(
        basename=os.path.basename,
        splitext=os.path.splitext,
        join=os.path.join,
        dirname=os.path.dirname,
        isfile=lambda p: True,
        getsize=lambda p: 10,
    )
    monkeypatch.setattr(
        main_mod,
        "os",
        types.SimpleNamespace(
            path=fake_path, makedirs=lambda *a, **kw: None, environ=os.environ
        ),
    )
    return types.SimpleNamespace(main=main_mod, s3=s3, temp_s3=temp_s3, miris_cls=miris_cls)


def _run(container, monkeypatch, definition):
    monkeypatch.setattr(sys, "argv", ["__main__.py", definition])
    container.main.main()


def test_main_writes_stream_metadata_next_to_the_usd_relative_path(container, monkeypatch):
    _run(container, monkeypatch, _definition(f"{ASSET_ID}/scenes/pump.usdz"))

    container.s3.put_object.assert_called_once()
    put = container.s3.put_object.call_args.kwargs
    assert put["Bucket"] == "asset-bucket"
    assert put["Key"] == f"{METADATA_PREFIX}scenes/pump.usdz.metadata.json"
    assert put["ContentType"] == "application/json"
    entries = _entries(json.loads(put["Body"]))
    assert entries["miris_asset_uuid"]["metadataValue"] == "0b6f4c9e-6a43-4bb5-9d0c-4b3e2b1f7a10"
    assert entries["miris_display_name"]["metadataValue"] == "Pump Housing"


def test_main_records_the_version_it_downloaded(container, monkeypatch):
    _run(container, monkeypatch, _definition(f"{ASSET_ID}/pump.usdz"))

    container.s3.download_file.assert_called_once_with(
        "asset-bucket", f"{ASSET_ID}/pump.usdz", "/workdir/pump.usdz",
        ExtraArgs={"VersionId": "v-downloaded"},
    )
    body = json.loads(container.s3.put_object.call_args.kwargs["Body"])
    assert _entries(body)["miris_source_version_id"]["metadataValue"] == "v-downloaded"


def test_main_writes_an_empty_source_version_for_an_unversioned_object(container, monkeypatch):
    container.s3.head_object.return_value = {"ContentLength": 10}

    _run(container, monkeypatch, _definition(f"{ASSET_ID}/pump.usdz"))

    container.s3.download_file.assert_called_once_with(
        "asset-bucket", f"{ASSET_ID}/pump.usdz", "/workdir/pump.usdz", ExtraArgs=None
    )
    body = json.loads(container.s3.put_object.call_args.kwargs["Body"])
    assert _entries(body)["miris_source_version_id"]["metadataValue"] == ""


def test_main_writes_no_mrx_object(container, monkeypatch):
    _run(container, monkeypatch, _definition(f"{ASSET_ID}/pump.usdz"))

    written = [c.kwargs["Key"] for c in container.s3.put_object.call_args_list]
    assert written and not any(key.endswith(".mrx") for key in written)


def test_main_fails_before_uploading_when_the_metadata_path_is_missing(container, monkeypatch):
    definition = json.loads(_definition(f"{ASSET_ID}/pump.usdz"))
    del definition["stages"][0]["outputMetadataFiles"]

    with pytest.raises(SystemExit) as exit_info:
        _run(container, monkeypatch, json.dumps(definition))

    assert exit_info.value.code == 7
    container.miris_cls.assert_not_called()
    container.s3.put_object.assert_not_called()


def test_asset_folder_download_pins_only_the_root_usd(tmp_path):
    main_mod = _load_main()
    root_key = f"{ASSET_ID}/scenes/pump.usda"
    texture_key = f"{ASSET_ID}/scenes/textures/wood.png"
    s3 = MagicMock()
    s3.get_paginator.return_value.paginate.return_value = [
        {"Contents": [{"Key": root_key}, {"Key": texture_key}]}
    ]
    s3.head_object.return_value = {"VersionId": "v-root"}

    def _download(bucket, key, local, ExtraArgs=None):
        with open(local, "wb") as f:
            f.write(b"x")

    s3.download_file.side_effect = _download

    total, version_id = main_mod._download_asset_folder(
        s3, "asset-bucket", ASSET_ID, str(tmp_path), root_key
    )

    assert (total, version_id) == (2, "v-root")
    s3.head_object.assert_called_once_with(Bucket="asset-bucket", Key=root_key)
    calls = {c.args[1]: c.kwargs.get("ExtraArgs") for c in s3.download_file.call_args_list}
    assert calls == {root_key: {"VersionId": "v-root"}, texture_key: None}
