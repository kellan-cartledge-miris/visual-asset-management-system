/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Hand-authored TypeScript declarations for @miris-inc/three.
 * The package does not ship .d.ts files as of v0.0.8.
 */

declare module "@miris-inc/three" {
    import { Object3D, Scene, Group, Camera, Controls } from "three";

    export interface MirisSceneOptions {
        viewerKey?: string | null;
    }

    export class MirisScene extends Scene {
        constructor(options?: MirisSceneOptions);
        viewerKey?: string | null;
        fetchAssets(tags?: string | string[]): Promise<Array<{ uuid: string; name: string }>>;
        remove(stream: MirisStream): this;
        close(): void;
    }

    export interface MirisStreamOptions {
        uuid: string;
        viewerKey?: string;
    }

    export interface MirisBounds {
        min: { x: number; y: number; z: number };
        max: { x: number; y: number; z: number };
    }

    export class MirisStream extends Group {
        constructor(options: MirisStreamOptions);
        readonly uuid: string;
        readonly viewerKey?: string;
        readonly isStream: true;
        addEventListener(
            event: "streamloaded" | "rootloaded" | "sceneloaded",
            handler: () => void
        ): void;
        removeFromParent(): this;
        // Undocumented but stable: queries the WASM engine's internal bounding box.
        // Box3.setFromObject() does not work on WASM-managed geometry, so this is
        // the only reliable way to fit a camera to streamed asset bounds. Call
        // after the 'sceneloaded' event for final geometry.
        getBounds(): MirisBounds;
    }

    export class MirisControls extends Controls<{ start: object; end: object }> {
        constructor(
            objects: Object3D | Iterable<Object3D> | null,
            camera: Camera,
            domElement: HTMLElement
        );
        readonly objects: Set<Object3D>;
        update(): void;
        dispose(): void;
    }
}
