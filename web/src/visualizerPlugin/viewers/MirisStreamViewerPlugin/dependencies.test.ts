/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type * as Dependencies from "./dependencies";

// jsdom cannot evaluate the SDK, so both packages are stand-ins. The components factory records
// the renderer choice at the moment the package is evaluated, which is when the real package
// registers its custom elements.
const mockMiris = { tryUseShark: true };
const mockEvents: string[] = [];
let mockComponentsFail = false;

jest.mock("@miris-inc/core", () => {
    mockEvents.push("core");
    return { Miris: mockMiris };
});
jest.mock("@miris-inc/components", () => {
    if (mockComponentsFail) throw new Error("chunk failed");
    mockEvents.push(`components tryUseShark=${mockMiris.tryUseShark}`);
    return {};
});

const mockRemovePluginStylesheets = jest.fn();
jest.mock("../../core/StylesheetManager", () => ({
    StylesheetManager: {
        removePluginStylesheets: (...args: unknown[]) => mockRemovePluginStylesheets(...args),
    },
}));

// The manager keeps its loaded/in-flight state in statics, and the SDK stand-ins record their own
// evaluation, so each test takes fresh module instances of all three.
const freshModule = () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("./dependencies") as typeof Dependencies;
};

const setWebGpu = (present: boolean) => {
    if (present) {
        Object.defineProperty(navigator, "gpu", { value: {}, configurable: true });
    } else {
        delete (navigator as Navigator & { gpu?: unknown }).gpu;
    }
};

beforeEach(() => {
    mockMiris.tryUseShark = true;
    mockEvents.length = 0;
    mockComponentsFail = false;
    mockRemovePluginStylesheets.mockClear();
    setWebGpu(false);
});

afterAll(() => {
    setWebGpu(false);
});

describe("hasWebGpu", () => {
    it("reports whether the browser exposes navigator.gpu", () => {
        const { hasWebGpu } = freshModule();
        expect(hasWebGpu()).toBe(false);
        setWebGpu(true);
        expect(hasWebGpu()).toBe(true);
    });
});

describe("MirisStreamDependencyManager.loadMirisStream", () => {
    it("selects the WebGL engine before the elements load when WebGPU is absent", async () => {
        const { MirisStreamDependencyManager } = freshModule();
        await MirisStreamDependencyManager.loadMirisStream();
        expect(mockMiris.tryUseShark).toBe(false);
        expect(mockEvents).toEqual(["core", "components tryUseShark=false"]);
    });

    it("leaves the SDK's WebGPU default in place when WebGPU is present", async () => {
        setWebGpu(true);
        const { MirisStreamDependencyManager } = freshModule();
        await MirisStreamDependencyManager.loadMirisStream();
        expect(mockMiris.tryUseShark).toBe(true);
        expect(mockEvents).toEqual(["core", "components tryUseShark=true"]);
    });

    it("shares one load between concurrent callers and is a no-op once loaded", async () => {
        const { MirisStreamDependencyManager } = freshModule();
        await Promise.all([
            MirisStreamDependencyManager.loadMirisStream(),
            MirisStreamDependencyManager.loadMirisStream(),
        ]);
        await MirisStreamDependencyManager.loadMirisStream();
        expect(mockEvents).toEqual(["core", "components tryUseShark=false"]);
    });

    it("rejects when the elements fail to load and retries on the next call", async () => {
        const { MirisStreamDependencyManager } = freshModule();
        mockComponentsFail = true;
        await expect(MirisStreamDependencyManager.loadMirisStream()).rejects.toThrow(
            "chunk failed"
        );

        mockComponentsFail = false;
        jest.resetModules();
        await expect(MirisStreamDependencyManager.loadMirisStream()).resolves.toBeUndefined();
        expect(mockEvents).toContain("components tryUseShark=false");
    });
});

describe("MirisStreamDependencyManager.cleanup", () => {
    it("removes the plugin stylesheets and allows a later load", async () => {
        const { MirisStreamDependencyManager } = freshModule();
        await MirisStreamDependencyManager.loadMirisStream();
        MirisStreamDependencyManager.cleanup();
        expect(mockRemovePluginStylesheets).toHaveBeenCalledWith("miris-stream-viewer");

        // The modules are cached, so a reload re-applies the renderer choice without re-evaluating.
        mockMiris.tryUseShark = true;
        await MirisStreamDependencyManager.loadMirisStream();
        expect(mockMiris.tryUseShark).toBe(false);
    });
});
