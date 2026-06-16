/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { StylesheetManager } from "../../core/StylesheetManager";

export class MirisStreamDependencyManager {
    private static loaded = false;
    private static readonly PLUGIN_ID = "miris-stream-viewer";

    static async loadMirisStream(): Promise<void> {
        if (MirisStreamDependencyManager.loaded) return;

        // SDK and Three.js are dynamic ESM imports — Vite will produce a
        // separate chunk and reuse `three` if it's already loaded by another
        // viewer (e.g. the Three.js viewer).
        const [mirisModule, threeModule] = await Promise.all([
            import("@miris-inc/three"),
            import("three"),
        ]);

        (window as any).__MIRIS = {
            MirisScene: mirisModule.MirisScene,
            MirisStream: mirisModule.MirisStream,
            MirisControls: mirisModule.MirisControls,
            THREE: threeModule,
        };

        MirisStreamDependencyManager.loaded = true;
    }

    static cleanup(): void {
        StylesheetManager.removePluginStylesheets(MirisStreamDependencyManager.PLUGIN_ID);
        // We intentionally do NOT delete window.__MIRIS — the SDK chunks stay
        // cached in case the user switches back to the Miris viewer. The
        // PluginRegistry handles re-load lifecycle.
        MirisStreamDependencyManager.loaded = false;
    }
}
