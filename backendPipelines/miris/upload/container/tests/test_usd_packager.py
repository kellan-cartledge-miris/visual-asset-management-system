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
