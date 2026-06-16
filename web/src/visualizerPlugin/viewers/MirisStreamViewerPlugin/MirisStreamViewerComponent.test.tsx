/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import MirisStreamViewerComponent from "./MirisStreamViewerComponent";

const VALID_UUID = "063393b4-4b0d-4196-a6d4-ebcde70c56c2";

// --- Mock @miris-inc/three ---
const mockSceneAdd = jest.fn();
const mockStreamRemoveFromParent = jest.fn();
const mockControlsDispose = jest.fn();
const mockControlsUpdate = jest.fn();
const mockSceneCtor = jest.fn();
const mockStreamCtor = jest.fn();
const mockControlsCtor = jest.fn();
const mockStreamAddEventListener = jest.fn();

jest.mock("@miris-inc/three", () => ({
    MirisScene: jest.fn().mockImplementation((opts) => {
        mockSceneCtor(opts);
        return { add: mockSceneAdd, viewerKey: opts.viewerKey };
    }),
    MirisStream: jest.fn().mockImplementation((opts) => {
        mockStreamCtor(opts);
        return {
            uuid: opts.uuid,
            removeFromParent: mockStreamRemoveFromParent,
            addEventListener: mockStreamAddEventListener,
        };
    }),
    MirisControls: jest.fn().mockImplementation((...args) => {
        mockControlsCtor(...args);
        return { update: mockControlsUpdate, dispose: mockControlsDispose };
    }),
}));

// --- Mock three (minimal renderer) ---
// Note: document.createElement cannot be called inside jest.mock() factories
// (static scope restriction). Use a plain object for domElement instead.
jest.mock("three", () => ({
    PerspectiveCamera: jest.fn().mockImplementation(() => ({
        aspect: 1,
        updateProjectionMatrix: jest.fn(),
    })),
    WebGLRenderer: jest.fn().mockImplementation(() => ({
        setSize: jest.fn(),
        setAnimationLoop: jest.fn(),
        domElement: { style: {}, addEventListener: jest.fn() } as unknown as HTMLCanvasElement,
        dispose: jest.fn(),
        renderLists: { dispose: jest.fn() },
        render: jest.fn(),
    })),
}));

// --- Mock the dependency manager (preload happens before component mounts) ---
jest.mock("./dependencies", () => ({
    MirisStreamDependencyManager: {
        loadMirisStream: jest.fn().mockResolvedValue(undefined),
        cleanup: jest.fn(),
    },
}));

// --- Mock downloadAsset ---
const mockDownloadAsset = jest.fn();
jest.mock("../../../services/APIService", () => ({
    downloadAsset: (...args: unknown[]) => mockDownloadAsset(...args),
}));

// --- Mock appCache ---
const mockAppCacheGet = jest.fn();
jest.mock("../../../services/appCache", () => ({
    appCache: {
        getItem: (key: string) => mockAppCacheGet(key),
    },
}));

// --- Mock global fetch (used to retrieve presigned URL content) ---
const realFetch = global.fetch;
beforeEach(() => {
    jest.clearAllMocks();
    mockAppCacheGet.mockReturnValue({ mirisViewerKey: "key-1234567890abcdef" });
    global.fetch = jest.fn().mockResolvedValue({
        text: () =>
            Promise.resolve(
                JSON.stringify({
                    schemaVersion: 1,
                    mirisAssetUuid: VALID_UUID,
                })
            ),
    }) as unknown as typeof fetch;
    mockDownloadAsset.mockResolvedValue([true, "https://signed.example.com/manifest"]);
});
afterAll(() => {
    global.fetch = realFetch;
});

const baseProps = {
    assetId: "asset-1",
    databaseId: "db-1",
    assetKey: "model.mrx",
    versionId: "v1",
    viewerMode: "wide",
    onViewerModeChange: jest.fn(),
};

describe("MirisStreamViewerComponent", () => {
    it("renders the not-configured banner when mirisViewerKey is missing", async () => {
        mockAppCacheGet.mockReturnValue({});
        render(<MirisStreamViewerComponent {...baseProps} />);
        await waitFor(() => expect(screen.getByText(/not configured/i)).toBeInTheDocument());
        expect(mockSceneCtor).not.toHaveBeenCalled();
    });

    it("renders an error overlay when manifest fails to parse", async () => {
        global.fetch = jest.fn().mockResolvedValue({
            text: () => Promise.resolve("not json {{"),
        }) as unknown as typeof fetch;

        render(<MirisStreamViewerComponent {...baseProps} />);
        await waitFor(() => expect(screen.getByText(/malformed|invalid/i)).toBeInTheDocument());
        expect(mockSceneCtor).not.toHaveBeenCalled();
    });

    it("instantiates MirisScene and MirisStream on the happy path", async () => {
        render(<MirisStreamViewerComponent {...baseProps} />);
        await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));
        expect(mockSceneCtor).toHaveBeenCalledWith({
            viewerKey: "key-1234567890abcdef",
        });
        expect(mockStreamCtor).toHaveBeenCalledWith({ uuid: VALID_UUID });
    });

    it("disposes controls, stream, renderer on unmount", async () => {
        const { unmount } = render(<MirisStreamViewerComponent {...baseProps} />);
        await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));

        await act(async () => {
            unmount();
        });
        expect(mockControlsDispose).toHaveBeenCalledTimes(1);
        expect(mockStreamRemoveFromParent).toHaveBeenCalledTimes(1);
    });
});
