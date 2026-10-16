/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import MirisStreamViewerComponent from "./MirisStreamViewerComponent";
import { MirisStreamDependencyManager } from "./dependencies";

const VALID_UUID = "063393b4-4b0d-4196-a6d4-ebcde70c56c2";

// jsdom cannot load the SDK (WASM, WebGL), so the custom elements stay undefined and render as
// plain elements whose attributes and events the tests drive directly.
jest.mock("@miris-inc/components", () => ({}));

// --- Mock the dependency manager (registers the custom elements in the browser) ---
jest.mock("./dependencies", () => ({
    MirisStreamDependencyManager: {
        loadMirisStream: jest.fn().mockResolvedValue(undefined),
        isDeviceSupported: jest.fn().mockReturnValue(true),
        cleanup: jest.fn(),
    },
}));
const mockLoadMirisStream = MirisStreamDependencyManager.loadMirisStream as jest.Mock;
const mockIsDeviceSupported = MirisStreamDependencyManager.isDeviceSupported as jest.Mock;

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

const sceneElement = () => document.querySelector("miris-scene");
const streamElement = () => document.querySelector("miris-stream");
const waitForScene = async (): Promise<Element> => {
    await waitFor(() => expect(sceneElement()).not.toBeNull());
    return sceneElement() as Element;
};

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
            await waitForScene();
            expect(mockDownloadAsset).not.toHaveBeenCalled();
        });
    });

    describe("streaming", () => {
        it("renders the scene with the viewer key and exactly the returned UUID", async () => {
            render(<MirisStreamViewerComponent {...baseProps} />);
            const scene = await waitForScene();
            expect(scene).toHaveAttribute("viewer-key", "key-1234567890abcdef");
            expect(scene).toHaveAttribute("camera-fit", "contain");
            expect(scene.querySelectorAll("miris-camera")).toHaveLength(1);
            expect(scene.querySelectorAll("miris-stream")).toHaveLength(1);
            expect(streamElement()).toHaveAttribute("uuid", VALID_UUID);
        });

        it("enables camera and stream controls and never renders controls as false", async () => {
            render(<MirisStreamViewerComponent {...baseProps} />);
            const scene = await waitForScene();
            const controlled = [
                scene.querySelector("miris-camera"),
                scene.querySelector("miris-stream"),
            ];
            for (const element of controlled) {
                // The elements treat any present `controls` attribute as enabled.
                expect(element).toHaveAttribute("controls");
                expect(element?.getAttribute("controls")).not.toBe("false");
            }
        });

        it("registers the SDK elements before rendering the scene", async () => {
            let finishLoad: () => void = () => undefined;
            mockLoadMirisStream.mockReturnValueOnce(
                new Promise<void>((resolve) => {
                    finishLoad = resolve;
                })
            );
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockLoadMirisStream).toHaveBeenCalledTimes(1));
            expect(sceneElement()).toBeNull();
            await act(async () => {
                finishLoad();
            });
            await waitForScene();
        });

        it("shows the load error when the SDK fails to load", async () => {
            mockLoadMirisStream.mockRejectedValueOnce(new Error("chunk"));
            const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() =>
                expect(screen.getByText(/miris viewer failed to load/i)).toBeInTheDocument()
            );
            expect(sceneElement()).toBeNull();
            consoleError.mockRestore();
        });

        it("labels the stream with the returned display name", async () => {
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(screen.getByText("Scene stream")).toBeInTheDocument());
        });

        it("streams when Miris could not be queried (state unknown)", async () => {
            mockGetMirisStreamStatus.mockResolvedValue(status({ state: "unknown" }));
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitForScene();
            expect(streamElement()).toHaveAttribute("uuid", VALID_UUID);
            expect(screen.queryByText(/preparing this asset/i)).not.toBeInTheDocument();
        });

        it("renders the not-configured banner when mirisViewerKey is missing", async () => {
            mockAppCacheGet.mockReturnValue({});
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(screen.getByText(/not configured/i)).toBeInTheDocument());
            expect(sceneElement()).toBeNull();
        });

        it("removes the scene when the viewed file is cleared", async () => {
            const view = render(<MirisStreamViewerComponent {...baseProps} />);
            await waitForScene();

            view.rerender(<MirisStreamViewerComponent {...baseProps} assetKey="" />);
            await waitFor(() => expect(sceneElement()).toBeNull());
            expect(screen.queryByText("Scene stream")).not.toBeInTheDocument();
        });

        it("removes the scene element on unmount", async () => {
            const { unmount } = render(<MirisStreamViewerComponent {...baseProps} />);
            await waitForScene();

            await act(async () => {
                unmount();
            });
            expect(sceneElement()).toBeNull();
        });
    });

    describe("load events", () => {
        afterEach(() => {
            jest.useRealTimers();
        });

        it("times out when the stream sends no data", async () => {
            jest.useFakeTimers();
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitForScene();

            await act(async () => {
                jest.advanceTimersByTime(60_000);
            });
            expect(screen.getByText(/timed out waiting for miris/i)).toBeInTheDocument();
            expect(screen.getByText(new RegExp(VALID_UUID))).toBeInTheDocument();
            expect(sceneElement()).toBeNull();
        });

        it("clears the timeout when the stream reports streamloaded", async () => {
            jest.useFakeTimers();
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitForScene();

            act(() => {
                streamElement()?.dispatchEvent(new CustomEvent("streamloaded"));
            });
            await act(async () => {
                jest.advanceTimersByTime(120_000);
            });
            expect(screen.queryByText(/timed out waiting for miris/i)).not.toBeInTheDocument();
            expect(sceneElement()).not.toBeNull();
        });

        it("clears the timeout on unmount", async () => {
            jest.useFakeTimers();
            const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
            const { unmount } = render(<MirisStreamViewerComponent {...baseProps} />);
            await waitForScene();
            unmount();
            await act(async () => {
                jest.advanceTimersByTime(60_000);
            });
            expect(jest.getTimerCount()).toBe(0);
            consoleError.mockRestore();
        });

        it("fails at once without mounting a scene when the device cannot render", async () => {
            jest.useFakeTimers();
            mockIsDeviceSupported.mockReturnValueOnce(false);
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() =>
                expect(screen.getByText(/not supported on this device/i)).toBeInTheDocument()
            );
            expect(mockLoadMirisStream).toHaveBeenCalledTimes(1);
            expect(sceneElement()).toBeNull();
            expect(streamElement()).toBeNull();
            expect(jest.getTimerCount()).toBe(0);
        });

        it("shows the unsupported-device error when the scene reports an error", async () => {
            render(<MirisStreamViewerComponent {...baseProps} />);
            const scene = await waitForScene();

            act(() => {
                scene.dispatchEvent(new Event("error"));
            });
            expect(screen.getByText(/not supported on this device/i)).toBeInTheDocument();
            expect(sceneElement()).toBeNull();
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
            expect(sceneElement()).toBeNull();
            expect(streamElement()).toBeNull();
        });
    });

    describe("errors", () => {
        it("shows an error for an invalid UUID without constructing the SDK", async () => {
            mockGetMirisStreamStatus.mockResolvedValue(
                status({ mirisAssetUuid: "not-a-uuid", state: "invalidUuid" })
            );
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(screen.getByText(/not a valid UUID/i)).toBeInTheDocument());
            expect(sceneElement()).toBeNull();
            expect(streamElement()).toBeNull();
        });

        it("shows an error when the status request fails", async () => {
            mockGetMirisStreamStatus.mockResolvedValue([false, "Not Authorized"]);
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() =>
                expect(
                    screen.getByText(/could not load the miris stream status/i)
                ).toBeInTheDocument()
            );
            expect(streamElement()).toBeNull();
        });

        it("shows an error when the status request throws", async () => {
            mockGetMirisStreamStatus.mockRejectedValue(new Error("network"));
            const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() =>
                expect(screen.getByText(/miris viewer failed to load/i)).toBeInTheDocument()
            );
            expect(streamElement()).toBeNull();
            consoleError.mockRestore();
        });

        it("surfaces a definitive Miris processing failure", async () => {
            mockGetMirisStreamStatus.mockResolvedValue(status({ state: "failed" }));
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() =>
                expect(screen.getByText(/miris processing failed/i)).toBeInTheDocument()
            );
            expect(sceneElement()).toBeNull();
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
            expect(sceneElement()).toBeNull();
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

            await waitFor(() => expect(streamElement()).toHaveAttribute("uuid", VALID_UUID));
            expect(screen.queryByText(/preparing this asset/i)).not.toBeInTheDocument();
        });
    });

    describe("stale banner", () => {
        it("shows the banner when the stream was built from a different version", async () => {
            mockGetMirisStreamStatus.mockResolvedValue(status({ sourceVersionId: "v0" }));
            render(<MirisStreamViewerComponent {...baseProps} versionId="v1" />);
            await waitFor(() => expect(screen.getByText(STALE_TEXT)).toBeInTheDocument());
            // Still streaming.
            expect(streamElement()).toHaveAttribute("uuid", VALID_UUID);
            expect(mockFetchFileInfo).not.toHaveBeenCalled();
        });

        it("shows no banner when the versions match", async () => {
            render(<MirisStreamViewerComponent {...baseProps} versionId="v1" />);
            await waitForScene();
            expect(screen.queryByText(STALE_TEXT)).not.toBeInTheDocument();
        });

        it.each([[""], [null]])(
            "shows no banner when the source version is %p",
            async (sourceVersionId) => {
                mockGetMirisStreamStatus.mockResolvedValue(status({ sourceVersionId }));
                render(<MirisStreamViewerComponent {...baseProps} versionId="v1" />);
                await waitForScene();
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
            await waitForScene();
            expect(screen.queryByText(STALE_TEXT)).not.toBeInTheDocument();
        });

        it("keeps streaming without a banner when the file info lookup fails", async () => {
            mockGetMirisStreamStatus.mockResolvedValue(status({ sourceVersionId: "v0" }));
            mockFetchFileInfo.mockResolvedValue([false, "Not Authorized"]);
            render(<MirisStreamViewerComponent {...baseProps} versionId={undefined} />);
            await waitFor(() => expect(mockFetchFileInfo).toHaveBeenCalledTimes(1));
            await waitForScene();
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
            await waitForScene();
            expect(mockMintMirisViewerKey).toHaveBeenCalledTimes(1);
            expect(mockMintMirisViewerKey).toHaveBeenCalledWith({
                databaseId: "db-1",
                assetId: "asset-1",
                filePath: "/asset-1/folder/scene.usd",
            });
            expect(sceneElement()).toHaveAttribute("viewer-key", MINTED_KEY);
            expect(streamElement()).toHaveAttribute("uuid", VALID_UUID);
        });

        it("ignores a shared key in the app config", async () => {
            mockAppCacheGet.mockReturnValue({
                featuresEnabled: ["MIRIS_PER_VIEW_KEYS"],
                mirisViewerKey: "shared-key",
            });
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitForScene();
            expect(sceneElement()).toHaveAttribute("viewer-key", MINTED_KEY);
        });

        it("never persists the minted key", async () => {
            const localSet = jest.spyOn(Storage.prototype, "setItem");
            const logSpies = [
                jest.spyOn(console, "log").mockImplementation(() => undefined),
                jest.spyOn(console, "warn").mockImplementation(() => undefined),
                jest.spyOn(console, "error").mockImplementation(() => undefined),
            ];
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitForScene();
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
            await waitForScene();
            first.unmount();
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockMintMirisViewerKey).toHaveBeenCalledTimes(2));
            await waitForScene();
        });

        it("shows a permission error on 403", async () => {
            mockMintMirisViewerKey.mockResolvedValue([false, "Forbidden", 403]);
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() =>
                expect(
                    screen.getByText("You do not have permission to stream this asset.")
                ).toBeInTheDocument()
            );
            expect(sceneElement()).toBeNull();
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
            expect(sceneElement()).toBeNull();
        });

        it("shows the not-yet-streamed guidance when the mint reports no stream", async () => {
            mockMintMirisViewerKey.mockResolvedValue([false, "not streamed", 404]);
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() =>
                expect(screen.getByText(/Not yet streamed with Miris/i)).toBeInTheDocument()
            );
            expect(sceneElement()).toBeNull();
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
            expect(sceneElement()).toBeNull();
            expect(mockLoadMirisStream).not.toHaveBeenCalled();
        });

        it("renders no scene until the minted key exists", async () => {
            let resolveMint: (value: unknown) => void = () => undefined;
            mockMintMirisViewerKey.mockReturnValue(
                new Promise((resolve) => {
                    resolveMint = resolve;
                })
            );
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitFor(() => expect(mockMintMirisViewerKey).toHaveBeenCalledTimes(1));
            expect(sceneElement()).toBeNull();
            await act(async () => {
                resolveMint(mintOk());
            });
            const scene = await waitForScene();
            expect(scene).toHaveAttribute("viewer-key", MINTED_KEY);
        });

        it("mounts a new scene element when the viewer key changes", async () => {
            mockMintMirisViewerKey
                .mockResolvedValueOnce(mintOk({ viewerKey: "first-key" }))
                .mockResolvedValueOnce(mintOk({ viewerKey: "second-key" }));
            const view = render(<MirisStreamViewerComponent {...baseProps} versionId="v1" />);
            const first = await waitForScene();
            expect(first).toHaveAttribute("viewer-key", "first-key");

            view.rerender(<MirisStreamViewerComponent {...baseProps} versionId="v2" />);
            await waitFor(() => expect(sceneElement()).toHaveAttribute("viewer-key", "second-key"));
            expect(sceneElement()).not.toBe(first);
            expect(first.isConnected).toBe(false);
        });

        it("falls back to the static path when featuresEnabled is malformed", async () => {
            mockAppCacheGet.mockReturnValue({
                featuresEnabled: false,
                mirisViewerKey: "key-1234567890abcdef",
            });
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitForScene();
            expect(mockMintMirisViewerKey).not.toHaveBeenCalled();
            expect(sceneElement()).toHaveAttribute("viewer-key", "key-1234567890abcdef");
        });

        it("does not mint without the per-view flag", async () => {
            mockAppCacheGet.mockReturnValue({ mirisViewerKey: "key-1234567890abcdef" });
            render(<MirisStreamViewerComponent {...baseProps} />);
            await waitForScene();
            expect(mockMintMirisViewerKey).not.toHaveBeenCalled();
            expect(sceneElement()).toHaveAttribute("viewer-key", "key-1234567890abcdef");
        });
    });
});
