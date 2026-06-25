/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useEffect, useState } from "react";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import { ViewerPluginProps } from "../../core/types";
import { triggerMirisUpload, fetchAssetS3Files } from "../../../services/APIService";
import { appCache } from "../../../services/appCache";
import MirisStreamViewerComponent from "../MirisStreamViewerPlugin/MirisStreamViewerComponent";

const SUPPORTED_EXTENSIONS = [".usd", ".usda", ".usdc", ".usdz"];
const MRX_EXTENSION = ".mrx";

function _fileName(f: any): string {
    return (f?.fileName ?? f?.relativePath ?? f?.name ?? f?.key ?? "").toLowerCase();
}

/**
 * Find the asset's .mrx manifest file, if one exists. The .mrx is produced by
 * the Miris upload pipeline once the asset has been registered for streaming,
 * and carries the Miris asset UUID the stream viewer needs.
 */
function _findMrx(files: any[]): any | undefined {
    return files.find((f) => _fileName(f).endsWith(MRX_EXTENSION));
}

/**
 * Pick the USD source file to hand to the Miris upload pipeline as its root input.
 * The pipeline requires a single file (it rejects a folder) and packages any
 * dependencies from that root. Heuristic: prefer the shallowest path (most likely
 * the asset root), and prefer a self-contained `.usdz` package on ties. Returns
 * undefined if the asset has no USD source file.
 */
function _findSupportedSource(files: any[]): any | undefined {
    const sources = files.filter((f) => {
        const name = _fileName(f);
        return SUPPORTED_EXTENSIONS.some((ext) => name.endsWith(ext));
    });
    if (sources.length === 0) return undefined;
    const depth = (f: any) => (_fileName(f).match(/\//g) || []).length;
    const isUsdz = (f: any) => _fileName(f).endsWith(".usdz");
    return sources.sort((a, b) => {
        const d = depth(a) - depth(b);
        if (d !== 0) return d;
        return Number(isUsdz(b)) - Number(isUsdz(a));
    })[0];
}

/**
 * Viewer-pane plugin for USD source files (.usd/.usda/.usdc/.usdz). Registered
 * via viewerConfig.json with `featuresEnabledRestriction: ["MIRIS_UPLOAD"]`, so
 * it self-disables when the Miris upload feature is off — no edits to core
 * asset-page components required.
 *
 * The plugin host only knows the file key being viewed, so this component
 * fetches the asset's real file list to decide what to render:
 *   - .mrx present + streaming configured -> stream it (delegates to the same
 *     MirisStreamViewerComponent used when the .mrx is selected directly, so a
 *     user can stream by selecting either the .mrx or its USD source)
 *   - .mrx present + streaming NOT configured -> "Already on Miris" note
 *   - no .mrx yet -> the upload CTA
 */
const MirisUploadViewerComponent: React.FC<ViewerPluginProps> = (props) => {
    const { assetId, databaseId } = props;
    const [files, setFiles] = useState<any[] | null>(null);
    const [running, setRunning] = useState(false);
    const [submitted, setSubmitted] = useState(false);

    useEffect(() => {
        let cancelled = false;
        if (!databaseId || !assetId) return;
        (async () => {
            try {
                const res = await fetchAssetS3Files({ databaseId, assetId });
                if (cancelled) return;
                setFiles(Array.isArray(res) && res[0] === true ? (res[1] as any[]) : []);
            } catch (e) {
                if (!cancelled) setFiles([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [databaseId, assetId]);

    const onClick = async (fileKey: string) => {
        setRunning(true);
        try {
            await triggerMirisUpload({ databaseId, assetId, fileKey });
            setSubmitted(true);
        } catch (e: any) {
            console.error("Failed to trigger Miris upload", e);
            setRunning(false);
        }
    };

    const center = (content: React.ReactNode) => (
        <div
            style={{
                width: "100%",
                height: "100%",
                minHeight: 320,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                padding: 24,
            }}
        >
            <div style={{ maxWidth: 420 }}>{content}</div>
        </div>
    );

    if (files === null) {
        return center(<Spinner size="large" />);
    }

    // If the asset is already on Miris (has a .mrx manifest), prefer to stream it
    // directly. We resolve the .mrx the USD source is associated with and hand its
    // key to the stream viewer — the exact same component used when the user
    // selects the .mrx itself. Requires a configured viewer key (MIRIS_STREAMING);
    // without one we can't stream, so we fall back to an informational note.
    const mrx = _findMrx(files);
    if (mrx) {
        const viewerKey = (appCache.getItem("config") as { mirisViewerKey?: string } | null)
            ?.mirisViewerKey;
        if (viewerKey) {
            return (
                <MirisStreamViewerComponent
                    {...props}
                    assetKey={mrx.key}
                    versionId={mrx.versionId ?? ""}
                />
            );
        }
        return center(
            <SpaceBetween size="s">
                <Box variant="h3">Already on Miris</Box>
                <Box variant="p" color="text-body-secondary">
                    This asset has been uploaded to Miris Spatial Streaming. Open its{" "}
                    <code>.mrx</code> file to view the stream.
                </Box>
            </SpaceBetween>
        );
    }

    const source = _findSupportedSource(files);
    if (!source) {
        return center(
            <Box variant="p" color="text-body-secondary">
                No USD source file (.usd / .usda / .usdc / .usdz) was found in this asset to
                upload to Miris.
            </Box>
        );
    }

    if (submitted) {
        return center(
            <SpaceBetween size="s">
                <Box variant="h3">Upload started</Box>
                <Box variant="p" color="text-body-secondary">
                    This asset is being uploaded to Miris. Once processing completes, a{" "}
                    <code>.mrx</code> manifest appears in the asset files and you can stream it.
                </Box>
            </SpaceBetween>
        );
    }

    return center(
        <SpaceBetween size="m">
            <Box variant="h3">Stream this asset with Miris</Box>
            <Box variant="p" color="text-body-secondary">
                Upload this USD asset to Miris Spatial Streaming. Miris prepares it for
                progressive 3D streaming; when ready, a <code>.mrx</code> manifest is added to
                the asset and you can stream it in the browser.
            </Box>
            <Button variant="primary" loading={running} onClick={() => onClick(source.key)}>
                Stream with Miris
            </Button>
        </SpaceBetween>
    );
};

export default MirisUploadViewerComponent;
