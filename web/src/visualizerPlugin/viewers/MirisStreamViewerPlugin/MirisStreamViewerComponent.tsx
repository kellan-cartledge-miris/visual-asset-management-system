/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useEffect, useRef, useState } from "react";
import { MirisScene, MirisStream } from "@miris-inc/three";
import { PerspectiveCamera, Vector3, WebGLRenderer } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ViewerPluginProps } from "../../core/types";
import { downloadAsset } from "../../../services/APIService";
import { appCache } from "../../../services/appCache";
import { parseMirisManifest, MirisManifest, MirisManifestErrorReason } from "./manifestParser";
import styles from "./MirisStreamViewer.module.css";

type ViewerError =
    | { kind: "NOT_CONFIGURED" }
    | { kind: "MANIFEST_PARSE"; reason: MirisManifestErrorReason }
    | { kind: "MANIFEST_FETCH" }
    | { kind: "STREAM_TIMEOUT"; uuid: string }
    | { kind: "WEBGL_UNAVAILABLE" };

/**
 * Position the camera so the streamed asset fits comfortably in the view, and set the
 * OrbitControls target to the asset center. Uses standard "fit to view" geometry:
 *   distance = (radius / sin(fov/2)) * padding
 * Camera is placed on a diagonal so the viewer sees three faces of the bounding box.
 * Mutates `camera` and `controls` in place; caller must already have wired them up.
 */
function frameCameraToBounds(
    bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
    camera: PerspectiveCamera,
    controls: OrbitControls
): void {
    const center = new Vector3(
        (bounds.min.x + bounds.max.x) / 2,
        (bounds.min.y + bounds.max.y) / 2,
        (bounds.min.z + bounds.max.z) / 2
    );
    const size = new Vector3(
        bounds.max.x - bounds.min.x,
        bounds.max.y - bounds.min.y,
        bounds.max.z - bounds.min.z
    );
    const radius = size.length() / 2 || 1; // protect against zero-size bounds
    const fovRad = (camera.fov * Math.PI) / 180;
    const distance = (radius / Math.sin(fovRad / 2)) * 1.4; // 1.4 = padding factor

    // Diagonal offset so the user sees the asset in 3/4 view, not flat-on.
    const direction = new Vector3(1, 0.6, 1).normalize();
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = Math.max(distance / 100, 0.01);
    camera.far = distance * 100;
    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.update();
}

function errorMessage(err: ViewerError): string {
    switch (err.kind) {
        case "NOT_CONFIGURED":
            return "Miris streaming is not configured for this deployment. Contact your administrator.";
        case "MANIFEST_PARSE":
            switch (err.reason) {
                case MirisManifestErrorReason.INVALID_JSON:
                    return "This .mrx file is malformed: invalid JSON.";
                case MirisManifestErrorReason.TOO_LARGE:
                    return "This .mrx file is malformed: file exceeds 16 KB.";
                case MirisManifestErrorReason.INVALID_SCHEMA:
                    return "This .mrx file is malformed: schemaVersion is missing or invalid.";
                case MirisManifestErrorReason.UNSUPPORTED_SCHEMA:
                    return "This .mrx file was created for a newer version of the Miris viewer plugin. Update VAMS to view this asset.";
                case MirisManifestErrorReason.MISSING_UUID:
                    return "This .mrx file is malformed: mirisAssetUuid is missing.";
                case MirisManifestErrorReason.INVALID_UUID:
                    return "This .mrx file is malformed: mirisAssetUuid is not a valid UUID.";
            }
            return "This .mrx file is malformed.";
        case "MANIFEST_FETCH":
            return "Could not download the manifest file. Try again.";
        case "STREAM_TIMEOUT":
            return `Could not stream from Miris (asset ${err.uuid}). The asset may have been removed or the viewer key may be revoked.`;
        case "WEBGL_UNAVAILABLE":
            return "Your browser does not support WebGL 2.0. Required browsers: Chrome 90+, Firefox 88+, Safari 14+, Edge 90+.";
    }
}

const MirisStreamViewerComponent: React.FC<ViewerPluginProps> = ({
    assetId,
    databaseId,
    assetKey,
    versionId,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<ViewerError | null>(null);
    const [manifest, setManifest] = useState<MirisManifest | null>(null);

    // Refs to instantiated SDK / Three.js objects for cleanup
    const sceneRef = useRef<MirisScene | null>(null);
    const streamRef = useRef<MirisStream | null>(null);
    const cameraRef = useRef<PerspectiveCamera | null>(null);
    const rendererRef = useRef<WebGLRenderer | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                if (!assetKey) return;
                setLoading(true);
                setError(null);

                // 1. Download manifest
                const dl = await downloadAsset({
                    assetId,
                    databaseId,
                    key: assetKey,
                    versionId: versionId || "",
                    downloadType: "assetFile",
                });
                if (!Array.isArray(dl) || dl[0] !== true) {
                    if (!cancelled) setError({ kind: "MANIFEST_FETCH" });
                    return;
                }
                const presignedUrl = dl[1] as string;

                // 2. Fetch and parse
                const response = await fetch(presignedUrl);
                const text = await response.text();
                const parsed = parseMirisManifest(text);
                if (!parsed.ok) {
                    if (!cancelled) setError({ kind: "MANIFEST_PARSE", reason: parsed.reason });
                    return;
                }
                if (cancelled) return;
                setManifest(parsed.manifest);

                // 3. Viewer key check
                const appConfig = appCache.getItem("config") as
                    | { mirisViewerKey?: string }
                    | undefined;
                const viewerKey = appConfig?.mirisViewerKey;
                if (!viewerKey) {
                    if (!cancelled) setError({ kind: "NOT_CONFIGURED" });
                    return;
                }

                // 4. WebGL renderer
                let renderer: WebGLRenderer;
                try {
                    renderer = new WebGLRenderer({ antialias: true });
                } catch (e) {
                    if (!cancelled) setError({ kind: "WEBGL_UNAVAILABLE" });
                    return;
                }
                rendererRef.current = renderer;

                // 5. Scene + stream + camera + controls
                const scene = new MirisScene({ viewerKey });
                sceneRef.current = scene;

                const stream = new MirisStream({ uuid: parsed.manifest.mirisAssetUuid });
                streamRef.current = stream;
                scene.add(stream as any);

                const camera = new PerspectiveCamera(50, 1);
                cameraRef.current = camera;

                if (containerRef.current) {
                    const { width, height } = containerRef.current.getBoundingClientRect();
                    renderer.setSize(width, height);
                    camera.aspect = width / height;
                    camera.updateProjectionMatrix();
                    try {
                        containerRef.current.appendChild(renderer.domElement);
                    } catch (_domErr) {
                        // domElement may not be a real Node in test environments; skip append
                    }
                }

                // Three.js OrbitControls — orbit + scroll-zoom + right-click-pan.
                // Miris docs explicitly recommend this over MirisControls (drag-rotate only).
                const controls = new OrbitControls(camera, renderer.domElement);
                controls.enableDamping = true;
                controls.dampingFactor = 0.08;
                controls.enableZoom = true;
                controls.enablePan = true;
                controlsRef.current = controls;

                // Provisional camera position — slightly off-origin so OrbitControls has a
                // direction to look in before the scene loads. Refined by frameCameraToBounds
                // on the 'sceneloaded' event below.
                camera.position.set(0, 0, 5);
                controls.target.set(0, 0, 0);
                controls.update();

                // 6. Load timing:
                //   - 'streamloaded' clears the 10s timeout (first data arrived).
                //   - 'sceneloaded' fires when the full hierarchy is resolved; that's when
                //     stream.getBounds() returns the final WASM bounding box. Box3.setFromObject
                //     does NOT work on Miris geometry — getBounds() is the only reliable path
                //     (documented as a stable undocumented API in Miris technical docs).
                const loadTimer = setTimeout(() => {
                    if (!cancelled)
                        setError({
                            kind: "STREAM_TIMEOUT",
                            uuid: parsed.manifest.mirisAssetUuid,
                        });
                }, 10_000);
                loadTimerRef.current = loadTimer;
                stream.addEventListener("streamloaded", () => clearTimeout(loadTimer));
                stream.addEventListener("sceneloaded", () => {
                    if (cancelled) return;
                    try {
                        frameCameraToBounds(stream.getBounds(), camera, controls);
                    } catch (e) {
                        // getBounds() can throw if called before geometry is ready in
                        // edge cases. Leaving the camera at its provisional position is
                        // a graceful fallback — orbit/zoom still works.
                        console.warn("Miris viewer: failed to fit camera to bounds", e);
                    }
                });

                // 7. Animation loop
                renderer.setAnimationLoop(() => {
                    controls.update();
                    renderer.render(scene as any, camera);
                });

                // 8. Debounced ResizeObserver
                if (containerRef.current && typeof ResizeObserver !== "undefined") {
                    const ro = new ResizeObserver((entries) => {
                        if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
                        resizeTimeoutRef.current = setTimeout(() => {
                            const { width, height } = entries[0].contentRect;
                            renderer.setSize(width, height);
                            camera.aspect = width / height;
                            camera.updateProjectionMatrix();
                        }, 100);
                    });
                    ro.observe(containerRef.current);
                    resizeObserverRef.current = ro;
                }

                if (!cancelled) setLoading(false);
            } catch (e) {
                // Diagnostic logging — do NOT pass the viewer key here.
                console.error("Miris viewer load failed", {
                    assetId,
                    databaseId,
                    assetKey,
                    error: e,
                });
                if (!cancelled) setError({ kind: "MANIFEST_FETCH" });
            }
        }

        void load();

        return () => {
            cancelled = true;
            if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
            if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
            if (resizeObserverRef.current) {
                resizeObserverRef.current.disconnect();
                resizeObserverRef.current = null;
            }
            if (rendererRef.current) rendererRef.current.setAnimationLoop(null);
            if (controlsRef.current) controlsRef.current.dispose();
            if (streamRef.current) streamRef.current.removeFromParent();
            if (rendererRef.current) {
                rendererRef.current.renderLists.dispose();
                rendererRef.current.dispose();
            }
            sceneRef.current = null;
            streamRef.current = null;
            controlsRef.current = null;
            rendererRef.current = null;
            cameraRef.current = null;
        };
    }, [assetId, databaseId, assetKey, versionId]);

    return (
        <div ref={containerRef} className={styles.container}>
            {error && <div className={styles.errorOverlay}>{errorMessage(error)}</div>}
            {loading && !error && <div className={styles.errorOverlay}>Loading…</div>}
            {manifest?.displayName && !error && !loading && (
                <div style={{ position: "absolute", top: 8, left: 8, color: "#fff" }}>
                    {manifest.displayName}
                </div>
            )}
        </div>
    );
};

export default MirisStreamViewerComponent;
