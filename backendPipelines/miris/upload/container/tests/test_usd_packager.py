#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from usd_packager import local_download_plan, should_skip_packaging


ASSET_ID = "x86487e0b-9f50-4b7b-9b59-8963c6791b56"


def test_local_download_plan_maps_keys_to_relative_paths():
    keys = [
        f"{ASSET_ID}/",  # folder marker -> skipped
        f"{ASSET_ID}/Red Armchair.usda",
        f"{ASSET_ID}/textures/wood.jpg",
        f"{ASSET_ID}/textures/wood_bump.jpg",
    ]
    plan = local_download_plan(keys, ASSET_ID)
    assert plan == [
        (f"{ASSET_ID}/Red Armchair.usda", "Red Armchair.usda"),
        (f"{ASSET_ID}/textures/wood.jpg", "textures/wood.jpg"),
        (f"{ASSET_ID}/textures/wood_bump.jpg", "textures/wood_bump.jpg"),
    ]


def test_local_download_plan_skips_keys_without_asset_prefix():
    keys = ["someOther/thing.usda", f"{ASSET_ID}/root.usda"]
    plan = local_download_plan(keys, ASSET_ID)
    assert plan == [(f"{ASSET_ID}/root.usda", "root.usda")]


def test_local_download_plan_requires_prefix_at_start():
    # asset id appearing mid-key (not as a leading prefix) must be rejected
    keys = [f"someOtherPrefix/{ASSET_ID}/file.usda", f"{ASSET_ID}/root.usda"]
    plan = local_download_plan(keys, ASSET_ID)
    assert plan == [(f"{ASSET_ID}/root.usda", "root.usda")]


def test_should_skip_packaging_true_when_no_dependencies():
    # one layer (the root itself), no asset deps
    assert should_skip_packaging(1, 0) is True


def test_should_skip_packaging_false_with_sublayer_or_textures():
    assert should_skip_packaging(2, 0) is False   # has a sublayer/reference
    assert should_skip_packaging(1, 3) is False    # has texture assets


import zipfile

import pytest


def _write_usda_with_texture(dir_path: str, texture_name: str = "tex.png") -> str:
    """Create root.usda referencing a texture asset + the texture file itself.
    Returns the root .usda path."""
    tex_path = os.path.join(dir_path, texture_name)
    with open(tex_path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + b"0" * 64)  # dummy but present
    root = os.path.join(dir_path, "root.usda")
    with open(root, "w") as f:
        f.write(
            '#usda 1.0\n'
            'def Material "M" {\n'
            '    def Shader "T" {\n'
            '        uniform token info:id = "UsdUVTexture"\n'
            f'        asset inputs:file = @./{texture_name}@\n'
            '    }\n'
            '}\n'
        )
    return root


def test_compute_dependencies_finds_texture(tmp_path):
    pytest.importorskip("pxr")
    from usd_packager import compute_dependencies

    root = _write_usda_with_texture(str(tmp_path))
    layers, assets, unresolved = compute_dependencies(root)

    assert unresolved == []
    assert any(a.endswith("tex.png") for a in assets)


def test_compute_dependencies_reports_unresolved_for_missing_ref(tmp_path):
    pytest.importorskip("pxr")
    from usd_packager import compute_dependencies

    # reference a texture that does not exist on disk
    root = os.path.join(str(tmp_path), "root.usda")
    with open(root, "w") as f:
        f.write(
            '#usda 1.0\n'
            'def Material "M" {\n'
            '    def Shader "T" {\n'
            '        uniform token info:id = "UsdUVTexture"\n'
            '        asset inputs:file = @/nonexistent/abs/missing.png@\n'
            '    }\n'
            '}\n'
        )
    layers, assets, unresolved = compute_dependencies(root)
    assert unresolved, "expected the missing absolute reference to be unresolved"


def test_package_usdz_bundles_root_and_texture(tmp_path):
    pytest.importorskip("pxr")
    from usd_packager import package_usdz

    root = _write_usda_with_texture(str(tmp_path))
    out = os.path.join(str(tmp_path), "out.usdz")
    package_usdz(root, out)

    assert os.path.exists(out)
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
    assert any(n.endswith("root.usda") for n in names)
    assert any(n.endswith("tex.png") for n in names)
