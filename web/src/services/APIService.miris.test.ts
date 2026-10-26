/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { getMirisStreamStatus, mintMirisViewerKey } from "./APIService";
import { ApiError, apiClient } from "./apiClient";

jest.mock("./apiClient", () => {
    const actual = jest.requireActual("./apiClient");
    return {
        ApiError: actual.ApiError,
        apiClient: { get: jest.fn(), post: jest.fn() },
    };
});

const mockGet = apiClient.get as jest.Mock;
const mockPost = apiClient.post as jest.Mock;

const STATUS = {
    filePath: "/folder/scene.usd",
    mirisAssetUuid: "8d65af7c-5412-404b-a494-fbd2cdb62442",
    sourceVersionId: "v-abc",
    uploadedAt: "2026-10-14T12:00:00Z",
    displayName: "Scene",
    state: "streamable",
};

describe("getMirisStreamStatus", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("calls the status route with filePath as a query parameter and no UUID", async () => {
        mockGet.mockResolvedValue(STATUS);
        await getMirisStreamStatus({
            databaseId: "db-1",
            assetId: "asset-1",
            filePath: "/folder/scene.usd",
        });
        expect(mockGet).toHaveBeenCalledWith("database/db-1/assets/asset-1/miris/asset-status", {
            queryStringParameters: { filePath: "/folder/scene.usd" },
        });
    });

    it("returns the status on success", async () => {
        mockGet.mockResolvedValue(STATUS);
        const result = await getMirisStreamStatus({
            databaseId: "db-1",
            assetId: "asset-1",
            filePath: "/folder/scene.usd",
        });
        expect(result).toEqual([true, STATUS]);
    });

    it("returns notStreamed as a successful status", async () => {
        const notStreamed = {
            ...STATUS,
            mirisAssetUuid: null,
            sourceVersionId: null,
            uploadedAt: null,
            displayName: null,
            state: "notStreamed",
        };
        mockGet.mockResolvedValue(notStreamed);
        const result = await getMirisStreamStatus({
            databaseId: "db-1",
            assetId: "asset-1",
            filePath: "/folder/scene.usd",
        });
        expect(result).toEqual([true, notStreamed]);
    });

    it("returns the error message when the request throws", async () => {
        mockGet.mockRejectedValue(new Error("Not Authorized"));
        const result = await getMirisStreamStatus({
            databaseId: "db-1",
            assetId: "asset-1",
            filePath: "/folder/scene.usd",
        });
        expect(result).toEqual([false, "Not Authorized"]);
    });

    it("returns an error for a response without a state", async () => {
        mockGet.mockResolvedValue({ message: "Validation Error" });
        const result = await getMirisStreamStatus({
            databaseId: "db-1",
            assetId: "asset-1",
            filePath: "/folder/scene.usd",
        });
        expect(result).toEqual([false, "Validation Error"]);
    });
});

const MINTED = {
    filePath: "/folder/scene.usd",
    mirisAssetUuid: "8d65af7c-5412-404b-a494-fbd2cdb62442",
    viewerKey: "minted-viewer-key",
    expiresAt: "2026-10-15T19:04:28Z",
};

const MINT_ARGS = { databaseId: "db-1", assetId: "asset-1", filePath: "/folder/scene.usd" };

describe("mintMirisViewerKey", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("posts the file path to the viewer key route and no UUID", async () => {
        mockPost.mockResolvedValue(MINTED);
        await mintMirisViewerKey(MINT_ARGS);
        expect(mockPost).toHaveBeenCalledWith("database/db-1/assets/asset-1/miris/viewer-key", {
            body: { filePath: "/folder/scene.usd" },
        });
    });

    it("returns the key on success", async () => {
        mockPost.mockResolvedValue(MINTED);
        expect(await mintMirisViewerKey(MINT_ARGS)).toEqual([true, MINTED]);
    });

    it.each([403, 404, 500, 502])("returns the HTTP status %i on failure", async (status) => {
        mockPost.mockRejectedValue(new ApiError(`failed ${status}`, status));
        const result = await mintMirisViewerKey(MINT_ARGS);
        expect(result).toHaveLength(4);
        expect(result).toEqual([false, `failed ${status}`, status, undefined]);
    });

    it("returns the state the error body reports", async () => {
        mockPost.mockRejectedValue(
            new ApiError("not linked", 403, { state: "notBound", message: "not linked" })
        );
        expect(await mintMirisViewerKey(MINT_ARGS)).toEqual([false, "not linked", 403, "notBound"]);
    });

    it("ignores a non-string state in the error body", async () => {
        mockPost.mockRejectedValue(new ApiError("Forbidden", 403, { state: 7 }));
        expect(await mintMirisViewerKey(MINT_ARGS)).toEqual([false, "Forbidden", 403, undefined]);
    });

    it("returns an undefined status when the request did not reach the API", async () => {
        mockPost.mockRejectedValue(new TypeError("Failed to fetch"));
        expect(await mintMirisViewerKey(MINT_ARGS)).toEqual([
            false,
            "Failed to fetch",
            undefined,
            undefined,
        ]);
    });

    it("treats a response without a viewer key as a failure", async () => {
        mockPost.mockResolvedValue({ ...MINTED, viewerKey: "" });
        const result = await mintMirisViewerKey(MINT_ARGS);
        expect(result[0]).toBe(false);
        expect(result[2]).toBeUndefined();
    });
});
