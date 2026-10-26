/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A host that keeps DynamicViewer mounted while its files change leaves the
 * compatibility effect as the only thing that can notice the file changed. It used
 * to touch the selection only when nothing was selected, which left the previously
 * chosen viewer mounted against a file it cannot render, and left a resolved "no
 * compatible viewers" error on screen as the only visible state.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { DynamicViewer } from "./DynamicViewer";
import viewerConfig from "../config/viewerConfig.json";

// Built inside the factory (which is hoisted) and read back through require().
jest.mock("../core/PluginRegistry", () => {
    const instance = {
        isInitialized: jest.fn(() => true),
        initialize: jest.fn().mockResolvedValue(undefined),
        getCompatibleViewers: jest.fn(() => [] as any[]),
        switchToPlugin: jest.fn(),
        loadPluginDependencies: jest.fn().mockResolvedValue(undefined),
        getCurrentlyLoadedPlugin: jest.fn(() => null),
        cleanup: jest.fn(),
    };
    return {
        PluginRegistry: { getInstance: () => instance },
        getFileExtensions: (files: any[]) =>
            Array.from(
                new Set(
                    files
                        .filter((file: any) => !file.isDirectory)
                        .map((file: any) =>
                            String(file.filename)
                                .slice(String(file.filename).lastIndexOf("."))
                                .toLowerCase()
                        )
                )
            ),
    };
});

jest.mock("../core/StylesheetManager", () => ({
    StylesheetManager: { getScopedClassName: (id: string) => `scoped-${id}` },
}));

const registry = () =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("../core/PluginRegistry").PluginRegistry.getInstance();

const metadata = (id: string, name: string, extensions: string[]) => ({
    config: {
        id,
        name,
        description: `${name} description`,
        componentPath: `./viewers/${id}`,
        supportedExtensions: extensions,
        supportsMultiFile: false,
        canFullscreen: false,
        priority: 1,
        dependencies: [],
        loadStrategy: "lazy",
        category: "3d",
        enabled: true,
    },
    isLoaded: false,
});

const THREEJS = metadata("threejs-viewer", "Three.js Viewer", [".glb"]);
const IFC = metadata("thatopenwebifc-viewer", "ThatOpen IFC BIM Viewer", [".ifc"]);
const BABYLON = metadata("gaussian-splat-viewer-babylonjs", "BabylonJS Splat", [".glb"]);

const file = (filename: string) => ({
    filename,
    key: `asset1/${filename}`,
    isDirectory: false,
    assetId: "a1",
    databaseId: "d1",
});

const view = (files: any[]) => (
    <DynamicViewer
        files={files as any}
        assetId="a1"
        databaseId="d1"
        viewerMode="wide"
        onViewerModeChange={() => undefined}
    />
);

describe("DynamicViewer", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        registry().isInitialized.mockReturnValue(true);
        registry().getCurrentlyLoadedPlugin.mockReturnValue(null);
        registry().loadPluginDependencies.mockResolvedValue(undefined);
        // Each plugin renders its own id so the mounted viewer is identifiable.
        registry().switchToPlugin.mockImplementation(async (id: string) => ({
            config: [THREEJS, IFC, BABYLON].find((m) => m.config.id === id)!.config,
            component: () => <div>{`viewer:${id}`}</div>,
            isLoaded: true,
        }));
    });

    it("swaps the mounted viewer when the new file needs a different one", async () => {
        registry().getCompatibleViewers.mockReturnValue([THREEJS]);
        const { rerender } = render(view([file("model.glb")]));
        await waitFor(() => expect(screen.getByText(/viewer:threejs-viewer/)).toBeInTheDocument());

        registry().getCompatibleViewers.mockReturnValue([IFC]);
        rerender(view([file("building.ifc")]));

        await waitFor(() =>
            expect(screen.getByText(/viewer:thatopenwebifc-viewer/)).toBeInTheDocument()
        );
        expect(screen.queryByText(/viewer:threejs-viewer/)).toBeNull();
    });

    it("gives the viewer picker a name that says what it does", async () => {
        // Without an ariaLabel the control's only accessible name is its
        // placeholder, and after a choice it is the selected viewer's name.
        //
        // Asserted on the COMPUTED accessible name, not on an `[aria-label="..."]` attribute: this
        // Cloudscape version does not put `ariaLabel` on the control. It renders a hidden span
        // holding the text and points the trigger's `aria-labelledby` at it, so an attribute query
        // finds nothing while the control is in fact correctly named. Resolving `aria-labelledby` is
        // what a screen reader does, so this keeps passing if Cloudscape switches between the two.
        registry().getCompatibleViewers.mockReturnValue([THREEJS, BABYLON]);
        render(view([file("model.glb")]));

        const named = (label: string) =>
            Array.from(document.querySelectorAll("[aria-label],[aria-labelledby]")).some((el) => {
                const direct = el.getAttribute("aria-label") ?? "";
                const resolved = (el.getAttribute("aria-labelledby") ?? "")
                    .split(/\s+/)
                    .filter(Boolean)
                    .map((id) => document.getElementById(id)?.textContent ?? "")
                    .join(" ");
                return `${direct} ${resolved}`.includes(label);
            });

        await waitFor(() => expect(named("Select viewer")).toBe(true));
        // Control: the helper discriminates rather than matching anything.
        expect(named("Select nonexistent control")).toBe(false);
    });

    it("keeps a selection that can still render the new file", async () => {
        // Positive control for the test above: the swap must be driven by the
        // selection falling out of the candidate set, not by every file change.
        registry().getCompatibleViewers.mockReturnValue([THREEJS]);
        const { rerender } = render(view([file("one.glb")]));
        await waitFor(() => expect(screen.getByText(/viewer:threejs-viewer/)).toBeInTheDocument());
        const switchCalls = registry().switchToPlugin.mock.calls.length;

        rerender(view([file("two.glb")]));

        await waitFor(() => expect(screen.getByText(/viewer:threejs-viewer/)).toBeInTheDocument());
        expect(registry().switchToPlugin.mock.calls.length).toBe(switchCalls);
    });

    it("auto-selects the Miris viewer over the Needle USD viewer for a USD file", async () => {
        // Both entries come from the real registry config, so this fails if their priorities
        // stop giving the Miris viewer a strict lead.
        const fromConfig = (id: string) => ({
            config: (viewerConfig as any).viewers.find((viewer: any) => viewer.id === id),
            isLoaded: false,
        });
        const usdViewers = [
            fromConfig("needletools-usd-viewer"),
            fromConfig("miris-stream-viewer"),
        ].sort((a, b) => a.config.priority - b.config.priority);
        registry().getCompatibleViewers.mockReturnValue(usdViewers);
        registry().switchToPlugin.mockImplementation(async (id: string) => ({
            config: usdViewers.find((m) => m.config.id === id)?.config,
            component: () => <div>{`viewer:${id}`}</div>,
            isLoaded: true,
        }));

        render(view([file("scene.usd")]));

        await waitFor(() =>
            expect(screen.getByText("viewer:miris-stream-viewer")).toBeInTheDocument()
        );
        expect(registry().switchToPlugin).not.toHaveBeenCalledWith("needletools-usd-viewer");
    });

    describe("without an autoSelect winner", () => {
        const fromConfig = (id: string) => ({
            config: { ...(viewerConfig as any).viewers.find((viewer: any) => viewer.id === id) },
            isLoaded: false,
        });
        const byPriority = (list: any[]) =>
            [...list].sort((a, b) => a.config.priority - b.config.priority);

        // With several candidates and no selection the host renders the chooser over an empty
        // viewer area.
        const expectChooser = async () => {
            await waitFor(() =>
                expect(screen.getByText("No Viewer Component Selected")).toBeInTheDocument()
            );
            expect(registry().switchToPlugin).not.toHaveBeenCalled();
        };

        it("sets autoSelect on the Miris entry only", () => {
            const flagged = (viewerConfig as any).viewers
                .filter((viewer: any) => viewer.autoSelect === true)
                .map((viewer: any) => viewer.id);
            expect(flagged).toEqual(["miris-stream-viewer"]);
        });

        it("opens a lone autoSelect viewer as it would any single viewer", async () => {
            const miris = fromConfig("miris-stream-viewer");
            registry().getCompatibleViewers.mockReturnValue([miris]);
            registry().switchToPlugin.mockImplementation(async (id: string) => ({
                config: miris.config,
                component: () => <div>{`viewer:${id}`}</div>,
                isLoaded: true,
            }));

            render(view([file("scene.usd")]));

            await waitFor(() =>
                expect(screen.getByText("viewer:miris-stream-viewer")).toBeInTheDocument()
            );
        });

        it("leaves a priority tie between autoSelect viewers to the user", async () => {
            const tied = (id: string) => ({
                ...metadata(id, id, [".usd"]),
                config: { ...metadata(id, id, [".usd"]).config, priority: 0, autoSelect: true },
            });
            registry().getCompatibleViewers.mockReturnValue([tied("first"), tied("second")]);

            render(view([file("scene.usd")]));

            await expectChooser();
        });

        it("asks for a choice among several viewers of a type that sets no autoSelect", async () => {
            // .csv: the Text Viewer outranks the Columnar Data Viewer, but neither opts in.
            const csvViewers = byPriority([
                fromConfig("columnar-viewer"),
                fromConfig("text-viewer"),
            ]);
            expect(csvViewers[0].config.priority).toBeLessThan(csvViewers[1].config.priority);
            registry().getCompatibleViewers.mockReturnValue(csvViewers);

            render(view([file("table.csv")]));

            await expectChooser();
        });

        it("asks for a choice for USD when the top viewer does not opt in", async () => {
            const miris = fromConfig("miris-stream-viewer");
            miris.config.autoSelect = false;
            registry().getCompatibleViewers.mockReturnValue(
                byPriority([fromConfig("needletools-usd-viewer"), miris])
            );

            render(view([file("scene.usd")]));

            await expectChooser();
        });
    });

    it("clears a no-compatible-viewer error once the user moves to a viewable file", async () => {
        registry().getCompatibleViewers.mockReturnValue([]);
        const { rerender } = render(view([file("data.zzz")]));
        await waitFor(() =>
            expect(
                screen.getByText(/No compatible viewers found for file types: \.zzz/)
            ).toBeInTheDocument()
        );

        // Two candidates: the selection stays null, so the load effect — the only
        // other place that cleared the error — never runs.
        registry().getCompatibleViewers.mockReturnValue([THREEJS, BABYLON]);
        rerender(view([file("model.glb")]));

        await waitFor(() => expect(screen.queryByText(/No compatible viewers found/)).toBeNull());
    });
});
