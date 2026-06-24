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

const SUPPORTED_EXTENSIONS = [".usd", ".usda", ".usdc", ".usdz"];
const MRX_EXTENSION = ".mrx";

function _fileName(f: any): string {
    return (f?.fileName ?? f?.relativePath ?? f?.name ?? f?.key ?? "").toLowerCase();
}

function _hasMrx(files: any[]): boolean {
    return files.some((f) => _fileName(f).endsWith(MRX_EXTENSION));
}

function _hasSupportedSource(files: any[]): boolean {
    return files.some((f) => {
        const name = _fileName(f);
        return SUPPORTED_EXTENSIONS.some((ext) => name.endsWith(ext));
    });
}

/**
 * Viewer-pane plugin that offers a "Stream with Miris" action for a USD asset
 * that has not yet been uploaded to Miris. Registered via viewerConfig.json with
 * `featuresEnabledRestriction: ["MIRIS_UPLOAD"]`, so it self-disables when the
 * Miris upload feature is off — no edits to core asset-page components required.
 *
 * It fetches the asset's real file list (the plugin host only knows the file
 * key being viewed) to decide what to show:
 *   - no .mrx yet  -> the upload CTA
 *   - .mrx present -> a note that the asset is already on Miris
 */
const MirisUploadViewerComponent: React.FC<ViewerPluginProps> = ({ assetId, databaseId }) => {
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

    const onClick = async () => {
        setRunning(true);
        try {
            await triggerMirisUpload({ databaseId, assetId });
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

    if (_hasMrx(files)) {
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

    if (!_hasSupportedSource(files)) {
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
            <Button variant="primary" loading={running} onClick={onClick}>
                Stream with Miris
            </Button>
        </SpaceBetween>
    );
};

export default MirisUploadViewerComponent;
