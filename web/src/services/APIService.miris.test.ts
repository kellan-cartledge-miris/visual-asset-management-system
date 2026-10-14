/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { getMirisStreamStatus } from "./APIService";
import { apiClient } from "./apiClient";

jest.mock("./apiClient", () => ({
    apiClient: { get: jest.fn() },
}));

const mockGet = apiClient.get as jest.Mock;

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
