/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { StylesheetManager } from "../../core/StylesheetManager";

/** True when the browser exposes WebGPU, which the SDK's default renderer requires. */
export function hasWebGpu(): boolean {
    return (
        typeof navigator !== "undefined" &&
        Boolean((navigator as Navigator & { gpu?: unknown }).gpu)
    );
}

export class MirisStreamDependencyManager {
    private static loaded = false;
    private static pending: Promise<void> | null = null;
    private static readonly PLUGIN_ID = "miris-stream-viewer";

    /**
     * Registers the <miris-scene>, <miris-camera>, <miris-stream> and <miris-group> custom
     * elements. The SDK renders with WebGPU by default and shows a "needs WebGPU" notice without
     * it, so where WebGPU is absent the WebGL engine is selected first. `Miris.tryUseShark` is
     * read when a scene is created, so it is set before any element can exist, on the same
     * `@miris-inc/core` module the elements import (one install, exact peer pins).
     */
    static async loadMirisStream(): Promise<void> {
        if (MirisStreamDependencyManager.loaded) return;
        MirisStreamDependencyManager.pending ??= (async () => {
            const { Miris } = await import("@miris-inc/core");
            if (!hasWebGpu()) Miris.tryUseShark = false;
            await import("@miris-inc/components");
            MirisStreamDependencyManager.loaded = true;
        })().finally(() => {
            MirisStreamDependencyManager.pending = null;
        });
        await MirisStreamDependencyManager.pending;
    }

    static cleanup(): void {
        StylesheetManager.removePluginStylesheets(MirisStreamDependencyManager.PLUGIN_ID);
        // Custom elements cannot be unregistered, and the SDK chunks stay cached in case the
        // user switches back to the Miris viewer. The PluginRegistry handles the re-load lifecycle.
        MirisStreamDependencyManager.loaded = false;
    }
}
