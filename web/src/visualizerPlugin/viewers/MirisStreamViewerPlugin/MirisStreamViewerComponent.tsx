/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useEffect, useRef, useState } from "react";
import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { MirisScene, MirisStream } from "@miris-inc/three";
import { PerspectiveCamera, Vector3, WebGLRenderer } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ViewerPluginProps } from "../../core/types";
import { fetchFileInfo, getMirisStreamStatus } from "../../../services/APIService";
import { appCache } from "../../../services/appCache";
import {
    isKnownVersionId,
    isStaleStream,
    latestVersionIdFromFileInfo,
    streamDisposition,
    toStatusFilePath,
} from "./streamStatus";
import styles from "./MirisStreamViewer.module.css";

type ViewerError =
    | { kind: "NOT_CONFIGURED" }
    | { kind: "STATUS_FETCH" }
    | { kind: "INVALID_UUID" }
    | { kind: "LOAD_FAILED" }
    | { kind: "STREAM_TIMEOUT"; uuid: string }
    | { kind: "WEBGL_UNAVAILABLE" }
    | { kind: "MIRIS_PROCESSING_ERROR" };

type ProcessingState = { state: string };

type StreamInfo = {
    uuid: string;
    displayName: string | null;
    sourceVersionId: string | null;
};

// Poll Miris status every 90s while an asset is still being prepared on the
// Miris side. Typical promotion to streamable takes 1–2 hours.
const PROCESSING_POLL_INTERVAL_MS = 90_000;

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
        case "STATUS_FETCH":
            return "Could not load the Miris stream status for this file. Try again.";
        case "INVALID_UUID":
            return "This file's miris_asset_uuid metadata is not a valid UUID. Correct it in the file's metadata, or run Stream with Miris again.";
        case "LOAD_FAILED":
            return "The Miris viewer failed to load. Try again.";
        case "STREAM_TIMEOUT":
            return (
                `Timed out waiting for Miris to start streaming asset ${err.uuid}. ` +
                "The asset reached a streamable state but the first frame didn't arrive in time. " +
                "Try reloading; if it keeps timing out, verify the asset still exists in app.miris.com."
            );
        case "WEBGL_UNAVAILABLE":
            return "Your browser does not support WebGL 2.0. Required browsers: Chrome 90+, Firefox 88+, Safari 14+, Edge 90+.";
        case "MIRIS_PROCESSING_ERROR":
            return "Miris processing failed. Check this asset in app.miris.com.";
    }
}

/**
 * Viewer for USD source files (.usd/.usda/.usdc/.usdz) that streams the Miris asset recorded
 * in the file's `miris_*` metadata. The stream status endpoint resolves that metadata server
 * side, so the viewer sends only the file path:
 *   - notStreamed  -> "Not yet streamed" guidance
 *   - invalidUuid  -> error
 *   - Miris still preparing the asset -> processing overlay, polled until it is streamable
 *   - otherwise    -> stream the returned UUID, with a stale banner when the stream was
 *                     built from a different version of the file than the one viewed
 */
const MirisStreamViewerComponent: React.FC<ViewerPluginProps> = ({
    assetId,
    databaseId,
    assetKey,
    versionId,
    assetVersionId,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<ViewerError | null>(null);
    const [notStreamed, setNotStreamed] = useState(false);
    const [streamInfo, setStreamInfo] = useState<StreamInfo | null>(null);
    const [staleStream, setStaleStream] = useState(false);
    const [processingState, setProcessingState] = useState<ProcessingState | null>(null);
    // Bumped when the status poll detects a state change so the main effect re-runs and
    // sets up the renderer. The dep on this var is what triggers re-entry into load().
    const [statusFlipTrigger, setStatusFlipTrigger] = useState(0);

    // Refs to instantiated SDK / Three.js objects for cleanup
    const sceneRef = useRef<MirisScene | null>(null);
    const streamRef = useRef<MirisStream | null>(null);
    const cameraRef = useRef<PerspectiveCamera | null>(null);
    const rendererRef = useRef<WebGLRenderer | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                if (!assetKey) return;
                setLoading(true);
                setError(null);
                setNotStreamed(false);

                // 1. Stream status of the viewed file
                const filePath = toStatusFilePath(assetKey);
                const statusResult = await getMirisStreamStatus({ databaseId, assetId, filePath });
                if (cancelled) return;
                if (statusResult[0] !== true) {
                    setError({ kind: "STATUS_FETCH" });
                    return;
                }
                const status = statusResult[1];

                const disposition = streamDisposition(status.state);
                if (disposition === "notStreamed") {
                    setStreamInfo(null);
                    setProcessingState(null);
                    setNotStreamed(true);
                    setLoading(false);
                    return;
                }
                if (disposition === "invalidUuid") {
                    setError({ kind: "INVALID_UUID" });
                    return;
                }
                if (disposition === "failed") {
                    setError({ kind: "MIRIS_PROCESSING_ERROR" });
                    return;
                }
                if (!status.mirisAssetUuid) {
                    setError({ kind: "STATUS_FETCH" });
                    return;
                }
                const uuid = status.mirisAssetUuid;
                setStreamInfo({
                    uuid,
                    displayName: status.displayName,
                    sourceVersionId: status.sourceVersionId,
                });

                // 2. Miris is still preparing the asset: overlay + poll. Any other
                // disposition re-runs load(), which handles it from the top.
                if (disposition === "processing") {
                    setProcessingState({ state: status.state });
                    setLoading(false);
                    if (pollIntervalRef.current) {
                        clearInterval(pollIntervalRef.current);
                    }
                    pollIntervalRef.current = setInterval(async () => {
                        try {
                            const r = await getMirisStreamStatus({
                                databaseId,
                                assetId,
                                filePath,
                            });
                            if (cancelled || r[0] !== true) return;
                            if (streamDisposition(r[1].state) === "processing") {
                                setProcessingState({ state: r[1].state });
                                return;
                            }
                            if (pollIntervalRef.current) {
                                clearInterval(pollIntervalRef.current);
                                pollIntervalRef.current = null;
                            }
                            setProcessingState(null);
                            setStatusFlipTrigger((c) => c + 1);
                        } catch (_pollErr) {
                            // Swallow transient poll errors; the next tick will retry.
                        }
                    }, PROCESSING_POLL_INTERVAL_MS);
                    return;
                }
                setProcessingState(null);

                // 3. Viewer key check
                const appConfig = appCache.getItem("config") as
                    | { mirisViewerKey?: string }
                    | undefined;
                const viewerKey = appConfig?.mirisViewerKey;
                if (!viewerKey) {
                    setError({ kind: "NOT_CONFIGURED" });
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

                const stream = new MirisStream({ uuid });
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
                // First-frame load includes WebSocket handshake + JWT validation +
                // initial octree fetch from the content CDN; 60s gives cold connections
                // headroom while still failing fast on a genuinely unreachable asset.
                const loadTimer = setTimeout(() => {
                    if (!cancelled) setError({ kind: "STREAM_TIMEOUT", uuid });
                }, 60_000);
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
                if (!cancelled) setError({ kind: "LOAD_FAILED" });
            }
        }

        void load();

        return () => {
            cancelled = true;
            if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
            if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
            }
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
    }, [assetId, databaseId, assetKey, versionId, statusFlipTrigger]);

    // Stale-stream check. The host passes the viewed file version as `versionId`, but it can
    // be absent for the current version (e.g. a basic-mode listing, or before the host has
    // resolved it), so the file's current S3 version is looked up instead. A historical asset
    // version without a file version id is not compared. Never blocks streaming.
    const sourceVersionId = streamInfo?.sourceVersionId;
    useEffect(() => {
        let cancelled = false;
        setStaleStream(false);
        if (!isKnownVersionId(sourceVersionId) || !assetKey) return;

        async function checkStale() {
            let viewedVersionId: string | undefined = isKnownVersionId(versionId)
                ? versionId
                : undefined;
            if (!viewedVersionId && !assetVersionId) {
                try {
                    const [ok, fileInfo] = await fetchFileInfo({
                        databaseId,
                        assetId,
                        fileKey: assetKey,
                        includeVersions: true,
                    });
                    if (ok) viewedVersionId = latestVersionIdFromFileInfo(fileInfo);
                } catch (_fileInfoErr) {
                    // Advisory only: without the current version there is nothing to compare.
                }
            }
            if (!cancelled) setStaleStream(isStaleStream(sourceVersionId, viewedVersionId));
        }

        void checkStale();
        return () => {
            cancelled = true;
        };
    }, [sourceVersionId, assetId, databaseId, assetKey, versionId, assetVersionId]);

    if (notStreamed && !error) {
        return (
            <div className={styles.guidance}>
                <div className={styles.guidanceContent}>
                    <SpaceBetween size="m">
                        <Box variant="h3">Not yet streamed with Miris</Box>
                        <Box variant="p" color="text-body-secondary">
                            This USD file has not been uploaded to Miris Spatial Streaming. Use the
                            file manager&apos;s <strong>Automation</strong> action to run{" "}
                            <strong>Stream with Miris</strong> on it; once processing completes, you
                            can stream it here.
                        </Box>
                    </SpaceBetween>
                </div>
            </div>
        );
    }

    const streaming = !!streamInfo && !error && !loading && !processingState;

    return (
        <div ref={containerRef} className={styles.container}>
            {error && <div className={styles.errorOverlay}>{errorMessage(error)}</div>}
            {processingState && !error && (
                <div className={styles.errorOverlay}>
                    <div>Miris is preparing this asset.</div>
                    <div style={{ marginTop: 16, opacity: 0.85 }}>
                        This usually takes 1&ndash;2 hours.
                    </div>
                    <div style={{ marginTop: 16, opacity: 0.85 }}>
                        The viewer will refresh automatically when it&rsquo;s ready.
                    </div>
                    <div style={{ marginTop: 16, opacity: 0.6 }}>
                        Current state: {processingState.state}
                    </div>
                </div>
            )}
            {loading && !error && !processingState && (
                <div className={styles.errorOverlay}>Loading…</div>
            )}
            {streaming && (streamInfo?.displayName || staleStream) && (
                <div className={styles.topOverlay}>
                    {streamInfo?.displayName && (
                        <div className={styles.label}>{streamInfo.displayName}</div>
                    )}
                    {staleStream && (
                        <Alert type="warning" statusIconAriaLabel="Warning">
                            This stream was built from a different version of this file. Run Stream
                            with Miris again to update it.
                        </Alert>
                    )}
                </div>
            )}
        </div>
    );
};

export default MirisStreamViewerComponent;
