/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { StylesheetManager } from "../../core/StylesheetManager";

/**
 * True when a throwaway canvas yields a WebGL 2 context, which the SDK's WebGL engine requires.
 * The context is released at once so the probe does not count against the browser's limit.
 */
export function hasWebGl2(): boolean {
    if (typeof document === "undefined") return false;
    try {
        const gl = document.createElement("canvas").getContext("webgl2");
        if (!gl) return false;
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        return true;
    } catch {
        return false;
    }
}

export class MirisStreamDependencyManager {
    private static loaded = false;
    private static pending: Promise<void> | null = null;
    private static supported = true;
    private static readonly PLUGIN_ID = "miris-stream-viewer";

    /**
     * Registers the <miris-scene>, <miris-camera>, <miris-stream> and <miris-group> custom
     * elements. The SDK renders with WebGPU by default and shows a "needs WebGPU" notice when the
     * browser grants no WebGPU adapter, so without one the WebGL engine is selected first, by the
     * SDK's own `useWebGPU()` (`@miris-inc/three` requests the adapter in a top-level await, so
     * the answer is settled once the import resolves). `Miris.tryUseShark` is read when a scene
     * is created, so it is set before any element can exist, on the same `@miris-inc/core`
     * module the elements import (one install, exact peer pins).
     */
    static async loadMirisStream(): Promise<void> {
        if (MirisStreamDependencyManager.loaded) return;
        MirisStreamDependencyManager.pending ??= (async () => {
            const { Miris } = await import("@miris-inc/core");
            const { useWebGPU } = await import("@miris-inc/three");
            const webGpu = useWebGPU();
            if (!webGpu) Miris.tryUseShark = false;
            MirisStreamDependencyManager.supported = webGpu || hasWebGl2();
            await import("@miris-inc/components");
            MirisStreamDependencyManager.loaded = true;
        })().finally(() => {
            MirisStreamDependencyManager.pending = null;
        });
        await MirisStreamDependencyManager.pending;
    }

    /**
     * Whether the engine chosen by the last load can render here. The WebGL engine needs a
     * WebGL 2 context: a scene mounted without one rejects while connecting and fires no event.
     */
    static isDeviceSupported(): boolean {
        return MirisStreamDependencyManager.supported;
    }

    static cleanup(): void {
        StylesheetManager.removePluginStylesheets(MirisStreamDependencyManager.PLUGIN_ID);
        // Custom elements cannot be unregistered, and the SDK chunks stay cached in case the
        // user switches back to the Miris viewer. The PluginRegistry handles the re-load lifecycle.
        MirisStreamDependencyManager.loaded = false;
    }
}
