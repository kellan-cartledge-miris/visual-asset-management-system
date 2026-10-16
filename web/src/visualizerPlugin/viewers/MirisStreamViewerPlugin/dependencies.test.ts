/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import type * as Dependencies from "./dependencies";

// jsdom cannot evaluate the SDK, so all three packages are stand-ins. The real `@miris-inc/three`
// awaits `navigator.gpu.requestAdapter()` at the top level and its `useWebGPU()` is
// `adapter !== null && Miris.tryUseShark`; the stand-in takes the adapter the test grants. The
// components factory records the renderer choice at the moment the package is evaluated, which
// is when the real package registers its custom elements.
const mockMiris = { tryUseShark: true };
const mockGpu: { adapter: object | null } = { adapter: null };
const mockEvents: string[] = [];
let mockComponentsFail = false;

jest.mock("@miris-inc/core", () => {
    mockEvents.push("core");
    return { Miris: mockMiris };
});
jest.mock("@miris-inc/three", () => {
    mockEvents.push("three");
    const canUseShark = mockGpu.adapter !== null;
    return { useWebGPU: () => canUseShark && mockMiris.tryUseShark };
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
// evaluation, so each test takes fresh module instances of all four.
const freshModule = () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("./dependencies") as typeof Dependencies;
};

// "absent": no navigator.gpu. "noAdapter": navigator.gpu exists but grants no adapter, as on a
// blocklisted GPU, with hardware acceleration off, or in a VDI session.
const setGpu = (state: "absent" | "noAdapter" | "adapter") => {
    if (state === "absent") {
        delete (navigator as Navigator & { gpu?: unknown }).gpu;
        mockGpu.adapter = null;
        return;
    }
    const adapter = state === "adapter" ? {} : null;
    Object.defineProperty(navigator, "gpu", {
        value: { requestAdapter: () => Promise.resolve(adapter) },
        configurable: true,
    });
    mockGpu.adapter = adapter;
};

const mockLoseContext = jest.fn();
const getContext = jest.spyOn(HTMLCanvasElement.prototype, "getContext");
const setWebGl2 = (available: boolean) => {
    getContext.mockImplementation(((type: string) =>
        available && type === "webgl2"
            ? {
                  getExtension: (name: string) =>
                      name === "WEBGL_lose_context" ? { loseContext: mockLoseContext } : null,
              }
            : null) as unknown as typeof HTMLCanvasElement.prototype.getContext);
};

beforeEach(() => {
    mockMiris.tryUseShark = true;
    mockEvents.length = 0;
    mockComponentsFail = false;
    mockRemovePluginStylesheets.mockClear();
    mockLoseContext.mockClear();
    getContext.mockClear();
    setGpu("absent");
    setWebGl2(true);
});

afterAll(() => {
    setGpu("absent");
    getContext.mockRestore();
});

describe("hasWebGl2", () => {
    it("reports a WebGL 2 context and releases it", () => {
        const { hasWebGl2 } = freshModule();
        expect(hasWebGl2()).toBe(true);
        expect(getContext).toHaveBeenCalledWith("webgl2");
        expect(mockLoseContext).toHaveBeenCalledTimes(1);
    });

    it("reports false when the canvas yields no WebGL 2 context", () => {
        setWebGl2(false);
        const { hasWebGl2 } = freshModule();
        expect(hasWebGl2()).toBe(false);
    });

    it("reports false when creating the context throws", () => {
        getContext.mockImplementation(() => {
            throw new Error("context creation failed");
        });
        const { hasWebGl2 } = freshModule();
        expect(hasWebGl2()).toBe(false);
    });
});

describe("MirisStreamDependencyManager.loadMirisStream", () => {
    it("selects the WebGL engine before the elements load when WebGPU is absent", async () => {
        const { MirisStreamDependencyManager } = freshModule();
        await MirisStreamDependencyManager.loadMirisStream();
        expect(mockMiris.tryUseShark).toBe(false);
        expect(mockEvents).toEqual(["core", "three", "components tryUseShark=false"]);
    });

    it("selects the WebGL engine when navigator.gpu grants no adapter", async () => {
        setGpu("noAdapter");
        const { MirisStreamDependencyManager } = freshModule();
        await MirisStreamDependencyManager.loadMirisStream();
        expect(mockMiris.tryUseShark).toBe(false);
        expect(mockEvents).toEqual(["core", "three", "components tryUseShark=false"]);
    });

    it("leaves the SDK's WebGPU default in place when an adapter is granted", async () => {
        setGpu("adapter");
        const { MirisStreamDependencyManager } = freshModule();
        await MirisStreamDependencyManager.loadMirisStream();
        expect(mockMiris.tryUseShark).toBe(true);
        expect(mockEvents).toEqual(["core", "three", "components tryUseShark=true"]);
    });

    it("supports the WebGL engine when WebGL 2 is available", async () => {
        const { MirisStreamDependencyManager } = freshModule();
        await MirisStreamDependencyManager.loadMirisStream();
        expect(getContext).toHaveBeenCalledTimes(1);
        expect(MirisStreamDependencyManager.isDeviceSupported()).toBe(true);
    });

    it("reports the device unsupported on the WebGL engine without WebGL 2", async () => {
        setGpu("noAdapter");
        setWebGl2(false);
        const { MirisStreamDependencyManager } = freshModule();
        await MirisStreamDependencyManager.loadMirisStream();
        expect(MirisStreamDependencyManager.isDeviceSupported()).toBe(false);
    });

    it("does not probe WebGL 2 on the WebGPU engine, which never creates a WebGL context", async () => {
        setGpu("adapter");
        setWebGl2(false);
        const { MirisStreamDependencyManager } = freshModule();
        await MirisStreamDependencyManager.loadMirisStream();
        expect(getContext).not.toHaveBeenCalled();
        expect(MirisStreamDependencyManager.isDeviceSupported()).toBe(true);
    });

    it("shares one load between concurrent callers and is a no-op once loaded", async () => {
        const { MirisStreamDependencyManager } = freshModule();
        await Promise.all([
            MirisStreamDependencyManager.loadMirisStream(),
            MirisStreamDependencyManager.loadMirisStream(),
        ]);
        await MirisStreamDependencyManager.loadMirisStream();
        expect(mockEvents).toEqual(["core", "three", "components tryUseShark=false"]);
        expect(getContext).toHaveBeenCalledTimes(1);
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
