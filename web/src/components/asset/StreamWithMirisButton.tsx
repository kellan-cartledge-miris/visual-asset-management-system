/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState } from "react";
import Button from "@cloudscape-design/components/button";
import { appCache } from "../../services/appCache";
import { triggerMirisUpload } from "../../services/APIService";

const SUPPORTED_EXTENSIONS = [".usd", ".usda", ".usdc", ".usdz"];
const MRX_EXTENSION = ".mrx";

interface FileLike {
    relativePath?: string;
    name?: string;
}

interface StreamWithMirisButtonProps {
    databaseId: string;
    assetId: string;
    files: FileLike[];
}

function _hasMrx(files: FileLike[]): boolean {
    return files.some((f) => (f.name ?? "").toLowerCase().endsWith(MRX_EXTENSION));
}

function _hasSupportedSource(files: FileLike[]): boolean {
    return files.some((f) => {
        const name = (f.name ?? "").toLowerCase();
        return SUPPORTED_EXTENSIONS.some((ext) => name.endsWith(ext));
    });
}

const StreamWithMirisButton: React.FC<StreamWithMirisButtonProps> = ({
    databaseId,
    assetId,
    files,
}) => {
    const [running, setRunning] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const config = appCache.getItem("config") as { featuresEnabled?: string } | undefined;
    const enabled = (config?.featuresEnabled ?? "").includes("MIRIS_UPLOAD");

    if (!enabled) return null;
    if (_hasMrx(files)) return null;
    if (!_hasSupportedSource(files)) return null;
    if (submitted) {
        return <span>Uploading to Miris…</span>;
    }

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

    return (
        <Button variant="primary" loading={running} onClick={onClick}>
            Stream with Miris
        </Button>
    );
};

export default StreamWithMirisButton;
