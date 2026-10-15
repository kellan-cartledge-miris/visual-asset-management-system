/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
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

// --- Mock three (minimal renderer + Vector3) ---
// Note: document.createElement cannot be called inside jest.mock() factories
// (static scope restriction). Use a plain object for domElement instead.
jest.mock("three", () => ({
    PerspectiveCamera: jest.fn().mockImplementation(() => ({
        aspect: 1,
        fov: 50,
        near: 0.1,
        far: 1000,
        position: { copy: jest.fn(), addScaledVector: jest.fn(), set: jest.fn() },
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
    Vector3: jest.fn().mockImplementation((x = 0, y = 0, z = 0) => ({
        x,
        y,
        z,
        set: jest.fn(),
        copy: jest.fn().mockReturnThis(),
        addScaledVector: jest.fn().mockReturnThis(),
        normalize: jest.fn().mockReturnThis(),
        length: jest.fn().mockReturnValue(1),
    })),
}));

// --- Mock OrbitControls (replaces MirisControls in the component) ---
const mockOrbitDispose = jest.fn();
const mockOrbitUpdate = jest.fn();
const mockOrbitCtor = jest.fn();
jest.mock("three/examples/jsm/controls/OrbitControls.js", () => ({
    OrbitControls: jest.fn().mockImplementation((...args) => {
        mockOrbitCtor(...args);
        return {
            update: mockOrbitUpdate,
            dispose: mockOrbitDispose,
            target: { copy: jest.fn(), set: jest.fn() },
            enableDamping: false,
            dampingFactor: 0,
            enableZoom: false,
            enablePan: false,
        };
    }),
}));

// --- Mock the dependency manager (preload happens before component mounts) ---
jest.mock("./dependencies", () => ({
    MirisStreamDependencyManager: {
        loadMirisStream: jest.fn().mockResolvedValue(undefined),
        cleanup: jest.fn(),
    },
}));

// --- Mock the stream status and file info calls ---
const mockGetMirisStreamStatus = jest.fn();
const mockFetchFileInfo = jest.fn();
const mockDownloadAsset = jest.fn();
const mockMintMirisViewerKey = jest.fn();
jest.mock("../../../services/APIService", () => ({
    getMirisStreamStatus: (...args: unknown[]) => mockGetMirisStreamStatus(...args),
    fetchFileInfo: (...args: unknown[]) => mockFetchFileInfo(...args),
    downloadAsset: (...args: unknown[]) => mockDownloadAsset(...args),
    mintMirisViewerKey: (...args: unknown[]) => mockMintMirisViewerKey(...args),
}));

// --- Mock appCache ---
const mockAppCacheGet = jest.fn();
const mockAppCacheSet = jest.fn();
jest.mock("../../../services/appCache", () => ({
    appCache: {
        getItem: (key: string) => mockAppCacheGet(key),
        setItem: (...args: unknown[]) => mockAppCacheSet(...args),
    },
}));

const status = (overrides: Record<string, unknown> = {}) => [
    true,
    {
        filePath: "/folder/scene.usd",
        mirisAssetUuid: VALID_UUID,
        sourceVersionId: "v1",
        uploadedAt: "2026-10-14T12:00:00Z",
        displayName: "Scene stream",
        state: "streamable",
        ...overrides,
    },
];

beforeEach(() => {
    jest.clearAllMocks();
    mockAppCacheGet.mockReturnValue({ mirisViewerKey: "key-1234567890abcdef" });
    mockGetMirisStreamStatus.mockResolvedValue(status());
    mockFetchFileInfo.mockResolvedValue([
        true,
        { versions: [{ versionId: "v1", isLatest: true }] },
    ]);
});

const baseProps = {
    assetId: "asset-1",
    databaseId: "db-1",
    assetKey: "asset-1/folder/scene.usd",
    versionId: "v1",
    viewerMode: "wide",
    onViewerModeChange: jest.fn(),
};

const STALE_TEXT = /built from a different version of this file/i;

describe("MirisStreamViewerComponent", () => {
    describe("status request", () => {
        it("asks for the status of the viewed file by its object key", async () => {
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockGetMirisStreamStatus).toHaveBeenCalledTimes(1));
            expect(mockGetMirisStreamStatus).toHaveBeenCalledWith({
                databaseId: "db-1",
                assetId: "asset-1",
                filePath: "/asset-1/folder/scene.usd",
            });
        });

        it("sends a key under a bucket prefix unchanged for the server to reduce", async () => {
            render(
                <MirisStreamViewerComponent
                    {...baseProps}
                    assetKey="projects/site-a/sub/scene.usd"
                />
            );
            await waitFor(() => expect(mockGetMirisStreamStatus).toHaveBeenCalledTimes(1));
            expect(mockGetMirisStreamStatus.mock.calls[0][0].filePath).toBe(
                "/projects/site-a/sub/scene.usd"
            );
        });

        it("never downloads the file", async () => {
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));
            expect(mockDownloadAsset).not.toHaveBeenCalled();
        });
    });

    describe("streaming", () => {
        it("constructs MirisStream with exactly the returned UUID", async () => {
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));
            expect(mockSceneCtor).toHaveBeenCalledWith({ viewerKey: "key-1234567890abcdef" });
            expect(mockStreamCtor).toHaveBeenCalledTimes(1);
            expect(mockStreamCtor).toHaveBeenCalledWith({ uuid: VALID_UUID });
        });

        it("labels the stream with the returned display name", async () => {
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(screen.getByText("Scene stream")).toBeInTheDocument());
        });

        it("streams when Miris could not be queried (state unknown)", async () => {
            mockGetMirisStreamStatus.mockResolvedValue(status({ state: "unknown" }));
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));
            expect(mockStreamCtor).toHaveBeenCalledWith({ uuid: VALID_UUID });
            expect(screen.queryByText(/preparing this asset/i)).not.toBeInTheDocument();
        });

        it("renders the not-configured banner when mirisViewerKey is missing", async () => {
            mockAppCacheGet.mockReturnValue({});
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(screen.getByText(/not configured/i)).toBeInTheDocument());
            expect(mockSceneCtor).not.toHaveBeenCalled();
        });

        it("disposes controls, stream, renderer on unmount", async () => {
            const { unmount } = render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));

            await act(async () => {
                unmount();
            });
            expect(mockOrbitDispose).toHaveBeenCalledTimes(1);
            expect(mockStreamRemoveFromParent).toHaveBeenCalledTimes(1);
        });

        it("registers a sceneloaded handler for camera framing", async () => {
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));
            // streamloaded (for timeout-clear) AND sceneloaded (for bounds-fit) should both be wired.
            const events = mockStreamAddEventListener.mock.calls.map((c) => c[0]);
            expect(events).toContain("streamloaded");
            expect(events).toContain("sceneloaded");
        });
    });

    describe("not streamed", () => {
        it("shows the Not yet streamed guidance and does not touch the SDK", async () => {
            mockGetMirisStreamStatus.mockResolvedValue(
                status({
                    mirisAssetUuid: null,
                    sourceVersionId: null,
                    uploadedAt: null,
                    displayName: null,
                    state: "notStreamed",
                })
            );
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() =>
                expect(screen.getByText(/not yet streamed with miris/i)).toBeInTheDocument()
            );
            expect(screen.getByText("Stream with Miris")).toBeInTheDocument();
            expect(screen.queryByRole("button")).not.toBeInTheDocument();
            expect(mockSceneCtor).not.toHaveBeenCalled();
            expect(mockStreamCtor).not.toHaveBeenCalled();
        });
    });

    describe("errors", () => {
        it("shows an error for an invalid UUID without constructing the SDK", async () => {
            mockGetMirisStreamStatus.mockResolvedValue(
                status({ mirisAssetUuid: "not-a-uuid", state: "invalidUuid" })
            );
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(screen.getByText(/not a valid UUID/i)).toBeInTheDocument());
            expect(mockSceneCtor).not.toHaveBeenCalled();
            expect(mockStreamCtor).not.toHaveBeenCalled();
        });

        it("shows an error when the status request fails", async () => {
            mockGetMirisStreamStatus.mockResolvedValue([false, "Not Authorized"]);
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() =>
                expect(
                    screen.getByText(/could not load the miris stream status/i)
                ).toBeInTheDocument()
            );
            expect(mockStreamCtor).not.toHaveBeenCalled();
        });

        it("shows an error when the status request throws", async () => {
            mockGetMirisStreamStatus.mockRejectedValue(new Error("network"));
            const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() =>
                expect(screen.getByText(/miris viewer failed to load/i)).toBeInTheDocument()
            );
            expect(mockStreamCtor).not.toHaveBeenCalled();
            consoleError.mockRestore();
        });

        it("surfaces a definitive Miris processing failure", async () => {
            mockGetMirisStreamStatus.mockResolvedValue(status({ state: "failed" }));
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() =>
                expect(screen.getByText(/miris processing failed/i)).toBeInTheDocument()
            );
            expect(mockSceneCtor).not.toHaveBeenCalled();
        });
    });

    describe("processing", () => {
        afterEach(() => {
            jest.useRealTimers();
        });

        it("shows the processing overlay while Miris is still preparing the asset", async () => {
            mockGetMirisStreamStatus.mockResolvedValue(status({ state: "preview" }));
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() =>
                expect(screen.getByText(/preparing this asset/i)).toBeInTheDocument()
            );
            expect(screen.getByText(/current state: preview/i)).toBeInTheDocument();
            expect(mockSceneCtor).not.toHaveBeenCalled();
        });

        it("starts streaming once the poll reports the asset streamable", async () => {
            jest.useFakeTimers();
            mockGetMirisStreamStatus
                .mockResolvedValueOnce(status({ state: "preview" }))
                .mockResolvedValue(status({ state: "streamable" }));
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() =>
                expect(screen.getByText(/preparing this asset/i)).toBeInTheDocument()
            );

            await act(async () => {
                jest.advanceTimersByTime(90_000);
            });

            await waitFor(() => expect(mockStreamCtor).toHaveBeenCalledWith({ uuid: VALID_UUID }));
            expect(screen.queryByText(/preparing this asset/i)).not.toBeInTheDocument();
        });
    });

    describe("stale banner", () => {
        it("shows the banner when the stream was built from a different version", async () => {
            mockGetMirisStreamStatus.mockResolvedValue(status({ sourceVersionId: "v0" }));
            render(<MirisStreamViewerComponent {...baseProps} versionId="v1" />);
            await waitFor(() => expect(screen.getByText(STALE_TEXT)).toBeInTheDocument());
            // Still streaming.
            expect(mockStreamCtor).toHaveBeenCalledWith({ uuid: VALID_UUID });
            expect(mockFetchFileInfo).not.toHaveBeenCalled();
        });

        it("shows no banner when the versions match", async () => {
            render(<MirisStreamViewerComponent {...baseProps} versionId="v1" />);
            await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));
            expect(screen.queryByText(STALE_TEXT)).not.toBeInTheDocument();
        });

        it.each([[""], [null]])(
            "shows no banner when the source version is %p",
            async (sourceVersionId) => {
                mockGetMirisStreamStatus.mockResolvedValue(status({ sourceVersionId }));
                render(<MirisStreamViewerComponent {...baseProps} versionId="v1" />);
                await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));
                expect(screen.queryByText(STALE_TEXT)).not.toBeInTheDocument();
                expect(mockFetchFileInfo).not.toHaveBeenCalled();
            }
        );

        it("compares against the file's current version when no versionId is passed", async () => {
            mockGetMirisStreamStatus.mockResolvedValue(status({ sourceVersionId: "v1" }));
            mockFetchFileInfo.mockResolvedValue([
                true,
                {
                    versions: [
                        { versionId: "v1", isLatest: false },
                        { versionId: "v2", isLatest: true },
                    ],
                },
            ]);
            render(<MirisStreamViewerComponent {...baseProps} versionId={undefined} />);
            await waitFor(() => expect(screen.getByText(STALE_TEXT)).toBeInTheDocument());
            expect(mockFetchFileInfo).toHaveBeenCalledWith({
                databaseId: "db-1",
                assetId: "asset-1",
                fileKey: "asset-1/folder/scene.usd",
                includeVersions: true,
            });
        });

        it("shows no banner when the current version matches the source", async () => {
            render(<MirisStreamViewerComponent {...baseProps} versionId={undefined} />);
            await waitFor(() => expect(mockFetchFileInfo).toHaveBeenCalledTimes(1));
            await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));
            expect(screen.queryByText(STALE_TEXT)).not.toBeInTheDocument();
        });

        it("keeps streaming without a banner when the file info lookup fails", async () => {
            mockGetMirisStreamStatus.mockResolvedValue(status({ sourceVersionId: "v0" }));
            mockFetchFileInfo.mockResolvedValue([false, "Not Authorized"]);
            render(<MirisStreamViewerComponent {...baseProps} versionId={undefined} />);
            await waitFor(() => expect(mockFetchFileInfo).toHaveBeenCalledTimes(1));
            await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));
            expect(screen.queryByText(STALE_TEXT)).not.toBeInTheDocument();
        });
    });

    describe("per-view viewer keys", () => {
        const MINTED_KEY = "minted-key-abcdef";
        const mintOk = (overrides: Record<string, unknown> = {}) => [
            true,
            {
                filePath: "/asset-1/folder/scene.usd",
                mirisAssetUuid: VALID_UUID,
                viewerKey: MINTED_KEY,
                expiresAt: "2026-10-15T13:00:00Z",
                ...overrides,
            },
        ];

        beforeEach(() => {
            mockAppCacheGet.mockReturnValue({
                featuresEnabled: "MIRIS_STREAMING,MIRIS_PER_VIEW_KEYS",
            });
            mockMintMirisViewerKey.mockResolvedValue(mintOk());
        });

        it("mints once for the viewed file and streams with the minted key", async () => {
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));
            expect(mockMintMirisViewerKey).toHaveBeenCalledTimes(1);
            expect(mockMintMirisViewerKey).toHaveBeenCalledWith({
                databaseId: "db-1",
                assetId: "asset-1",
                filePath: "/asset-1/folder/scene.usd",
            });
            expect(mockSceneCtor).toHaveBeenCalledWith({ viewerKey: MINTED_KEY });
            expect(mockStreamCtor).toHaveBeenCalledWith({ uuid: VALID_UUID });
        });

        it("ignores a shared key in the app config", async () => {
            mockAppCacheGet.mockReturnValue({
                featuresEnabled: ["MIRIS_PER_VIEW_KEYS"],
                mirisViewerKey: "shared-key",
            });
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));
            expect(mockSceneCtor).toHaveBeenCalledWith({ viewerKey: MINTED_KEY });
        });

        it("never persists the minted key", async () => {
            const localSet = jest.spyOn(Storage.prototype, "setItem");
            const logSpies = [
                jest.spyOn(console, "log").mockImplementation(() => undefined),
                jest.spyOn(console, "warn").mockImplementation(() => undefined),
                jest.spyOn(console, "error").mockImplementation(() => undefined),
            ];
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));
            expect(localSet).not.toHaveBeenCalled();
            expect(mockAppCacheSet).not.toHaveBeenCalled();
            for (const spy of logSpies) {
                expect(JSON.stringify(spy.mock.calls)).not.toContain(MINTED_KEY);
            }
            localSet.mockRestore();
            logSpies.forEach((spy) => spy.mockRestore());
        });

        it("mints again on a remount", async () => {
            const first = render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));
            first.unmount();
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(2));
            expect(mockMintMirisViewerKey).toHaveBeenCalledTimes(2);
        });

        it("shows a permission error on 403", async () => {
            mockMintMirisViewerKey.mockResolvedValue([false, "Forbidden", 403]);
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() =>
                expect(
                    screen.getByText("You do not have permission to stream this asset.")
                ).toBeInTheDocument()
            );
            expect(mockSceneCtor).not.toHaveBeenCalled();
        });

        it.each([
            ["a 500", [false, "boom", 500]],
            ["an unknown status", [false, "no response", undefined]],
            ["a different asset UUID", mintOk({ mirisAssetUuid: "other-uuid" })],
        ])("shows a retryable error on %s", async (_label, result) => {
            mockMintMirisViewerKey.mockResolvedValue(result);
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() =>
                expect(screen.getByText(/Could not get access to stream/i)).toBeInTheDocument()
            );
            expect(mockSceneCtor).not.toHaveBeenCalled();
        });

        it("shows the not-yet-streamed guidance when the mint reports no stream", async () => {
            mockMintMirisViewerKey.mockResolvedValue([false, "not streamed", 404]);
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() =>
                expect(screen.getByText(/Not yet streamed with Miris/i)).toBeInTheDocument()
            );
            expect(mockSceneCtor).not.toHaveBeenCalled();
        });

        it("builds no scene when unmounted before the mint resolves", async () => {
            let resolveMint: (value: unknown) => void = () => undefined;
            mockMintMirisViewerKey.mockReturnValue(
                new Promise((resolve) => {
                    resolveMint = resolve;
                })
            );
            const view = render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockMintMirisViewerKey).toHaveBeenCalledTimes(1));
            view.unmount();
            await act(async () => {
                resolveMint(mintOk());
            });
            expect(mockSceneCtor).not.toHaveBeenCalled();
        });

        it("falls back to the static path when featuresEnabled is malformed", async () => {
            mockAppCacheGet.mockReturnValue({
                featuresEnabled: false,
                mirisViewerKey: "key-1234567890abcdef",
            });
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));
            expect(mockMintMirisViewerKey).not.toHaveBeenCalled();
            expect(mockSceneCtor).toHaveBeenCalledWith({ viewerKey: "key-1234567890abcdef" });
        });

        it("does not mint without the per-view flag", async () => {
            mockAppCacheGet.mockReturnValue({ mirisViewerKey: "key-1234567890abcdef" });
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockSceneCtor).toHaveBeenCalledTimes(1));
            expect(mockMintMirisViewerKey).not.toHaveBeenCalled();
            expect(mockSceneCtor).toHaveBeenCalledWith({ viewerKey: "key-1234567890abcdef" });
        });
    });
});
