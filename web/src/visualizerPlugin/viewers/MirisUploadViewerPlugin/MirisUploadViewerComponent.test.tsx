/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import MirisUploadViewerComponent from "./MirisUploadViewerComponent";

const mockFetchAssetS3Files = jest.fn();
jest.mock("../../../services/APIService", () => ({
    fetchAssetS3Files: (...args: unknown[]) => mockFetchAssetS3Files(...args),
}));

const mockAppCacheGet = jest.fn();
jest.mock("../../../services/appCache", () => ({
    appCache: { getItem: (key: string) => mockAppCacheGet(key) },
}));

jest.mock("../MirisStreamViewerPlugin/MirisStreamViewerComponent", () => ({
    __esModule: true,
    default: () => <div>stream-viewer</div>,
}));

const baseProps = {
    assetId: "asset-1",
    databaseId: "db-1",
    assetKey: "model.usdz",
    versionId: "v1",
    viewerMode: "wide",
    onViewerModeChange: jest.fn(),
} as any;

describe("MirisUploadViewerComponent", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAppCacheGet.mockReturnValue({});
    });

    it("does not render a manual launch button for an un-uploaded USD asset, and points to the file manager's Automation action", async () => {
        mockFetchAssetS3Files.mockResolvedValue([true, [{ key: "asset-1/model.usdz" }]]);

        render(<MirisUploadViewerComponent {...baseProps} />);

        await waitFor(() => expect(screen.getByText(/automation/i)).toBeInTheDocument());
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("still delegates to the stream viewer when a .mrx manifest and viewer key are present", async () => {
        mockAppCacheGet.mockReturnValue({ mirisViewerKey: "key-1234567890abcdef" });
        mockFetchAssetS3Files.mockResolvedValue([
            true,
            [{ key: "asset-1/model.usdz" }, { key: "asset-1/model.mrx", versionId: "v2" }],
        ]);

        render(<MirisUploadViewerComponent {...baseProps} />);

        await waitFor(() => expect(screen.getByText("stream-viewer")).toBeInTheDocument());
    });
});
