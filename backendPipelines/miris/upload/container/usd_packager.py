#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
"""USD multi-file packaging helpers for the Miris upload container.

`pxr` (from usd-core) is imported lazily inside the wrapper functions so the
pure helpers below import without usd-core installed (keeps their unit tests
light). See compute_dependencies / package_usdz in Task 2.
"""
from typing import List, Tuple


def local_download_plan(keys: List[str], asset_id: str) -> List[Tuple[str, str]]:
    """Map S3 keys under `{asset_id}/` to (key, relative_path) download pairs.

    Skips folder markers (keys ending in '/') and any key that does not sit
    under the asset prefix. The relative path preserves subdirectory structure
    (e.g. 'textures/wood.jpg') so USD relative references resolve on local disk.
    """
    prefix = f"{asset_id}/"
    plan: List[Tuple[str, str]] = []
    for key in keys:
        if key.endswith("/"):
            continue
        if not key.startswith(prefix):
            continue
        rel = key[len(prefix):]
        if not rel:
            continue
        plan.append((key, rel))
    return plan


def should_skip_packaging(num_layers: int, num_assets: int) -> bool:
    """Return True when the root USD has no external dependencies.

    `ComputeAllDependencies` returns the root layer in `layers`, so a
    dependency-free asset has exactly one layer and zero referenced assets.
    In that case we upload the original file unchanged.
    """
    return num_layers <= 1 and num_assets == 0


def compute_dependencies(root_path: str):
    """Resolve the full dependency set of a root USD file.

    Returns (layer_identifiers, asset_paths, unresolved_paths). A non-empty
    unresolved_paths means a reference (commonly an absolute texture path)
    could not be located on disk — the caller should fail clean rather than
    ship an incomplete package to Miris.
    """
    from pxr import UsdUtils

    layers, assets, unresolved = UsdUtils.ComputeAllDependencies(root_path)
    return (
        [layer.identifier for layer in layers],
        list(assets),
        list(unresolved),
    )


def package_usdz(root_path: str, out_path: str) -> None:
    """Bundle the root USD and all resolved dependencies into a .usdz package."""
    from pxr import Sdf, UsdUtils

    ok = UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(root_path), out_path)
    if not ok:
        raise RuntimeError(f"usdz packaging failed for {root_path}")
