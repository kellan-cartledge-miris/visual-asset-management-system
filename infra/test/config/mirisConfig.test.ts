/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `getConfig()` rules for `app.miris`: defaults, the legacy `app.miris.upload.apiKeySecretArn` and
 * `app.miris.upload.mirisApiBaseUrl` aliases, the viewer key mode, and the per-view key lifetime.
 *
 * Every rejection asserts on the MESSAGE. A Miris config can be invalid in several ways at once, so a
 * bare `.toThrow()` would pass while the rule under test did nothing.
 */

import * as fs from "fs";
import * as Config from "../../config/config";
import commercialTemplate from "../../config/config.template.commercial.json";
import { newTestApp } from "../support/testApp";

const realReadFileSync = jest.requireActual("fs").readFileSync;

jest.mock("fs", () => {
    const actual = jest.requireActual("fs");
    return { ...actual, readFileSync: jest.fn(actual.readFileSync) };
});

const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-miris-api-key-AbCdEf";
const OTHER_SECRET_ARN =
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:other-miris-api-key-GhIjKl";
const VIEWER_KEY = "test-placeholder-viewer-key-000000";

/** Builds a config.json from the commercial template, applies `mutate`, and calls getConfig(). */
function resolve(mutate: (c: any) => void): () => Config.Config {
    const config = JSON.parse(JSON.stringify(commercialTemplate));
    config.env.region = "us-east-1";
    config.env.account = "123456789012";
    config.app.baseStackName = "vamstest";
    mutate(config);
    (fs.readFileSync as unknown as jest.Mock).mockImplementation(
        (p: string, ...rest: unknown[]) => {
            if (typeof p === "string" && p.endsWith("config.json")) return JSON.stringify(config);
            return realReadFileSync(p, ...rest);
        }
    );
    return () => Config.getConfig(newTestApp());
}

/** The Miris block as an operator who copied the template before the settings moved would have it. */
function legacyMirisBlock() {
    return {
        enabled: false,
        viewerKey: "UNDEFINED",
        upload: {
            enabled: false,
            autoRegisterWithVAMS: true,
            autoRegisterAutoTriggerOnFileUpload: true,
            triggerExtensions: ".usd,.usda,.usdc,.usdz",
            apiKeySecretArn: "UNDEFINED",
            mirisApiBaseUrl: "https://app.miris.com",
            taskTimeoutSeconds: 1800,
            maxAssetSizeBytes: 5000000000,
        },
    };
}

function enableMiris(c: any) {
    c.app.webUi.allowUnsafeEvalFeatures = true;
    c.app.miris.enabled = true;
    c.app.miris.viewerKey = VIEWER_KEY;
}

function enablePerView(c: any) {
    enableMiris(c);
    c.app.miris.viewerKeyMode = "perView";
    c.app.miris.viewerKey = "UNDEFINED";
    c.app.miris.apiKeySecretArn = SECRET_ARN;
}

let warn: jest.SpyInstance;

beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
    warn.mockRestore();
    // Restored to delegating rather than cleared, or a later test in this process reads nothing.
    (fs.readFileSync as unknown as jest.Mock).mockImplementation(realReadFileSync);
});

function warnings(): string[] {
    return warn.mock.calls.map((args) => String(args[0]));
}

function mirisWarnings(): string[] {
    return warnings().filter((w) => w.includes("app.miris"));
}

describe("defaults", () => {
    test("the shipped template resolves to static mode, a 15 minute TTL and app.miris.com", () => {
        const miris = resolve(() => undefined)().app.miris;
        expect(miris.viewerKeyMode).toBe("static");
        expect(miris.perViewKey.ttlMinutes).toBe(15);
        expect(miris.mirisApiBaseUrl).toBe("https://app.miris.com");
        expect(mirisWarnings()).toEqual([]);
    });

    test("a config without app.miris gets every Miris default", () => {
        const miris = resolve((c) => delete c.app.miris)().app.miris;
        expect(miris.enabled).toBe(false);
        expect(miris.viewerKeyMode).toBe("static");
        expect(miris.apiKeySecretArn).toBe("");
        expect(miris.mirisApiBaseUrl).toBe("https://app.miris.com");
        expect(miris.perViewKey).toEqual({ ttlMinutes: 15 });
        expect(miris.upload.enabled).toBe(false);
        expect(miris.upload).not.toHaveProperty("apiKeySecretArn");
        expect(miris.upload).not.toHaveProperty("mirisApiBaseUrl");
    });

    test("each missing field is filled on its own when app.miris exists", () => {
        const miris = resolve((c) => {
            c.app.miris = { enabled: false, viewerKey: "UNDEFINED" };
        })().app.miris;
        expect(miris.viewerKeyMode).toBe("static");
        expect(miris.apiKeySecretArn).toBe("");
        expect(miris.mirisApiBaseUrl).toBe("https://app.miris.com");
        expect(miris.perViewKey).toEqual({ ttlMinutes: 15 });
        expect(miris.upload.taskTimeoutSeconds).toBe(1800);
    });

    test("a null ttlMinutes is treated as absent and gets 15", () => {
        const miris = resolve((c) => {
            c.app.miris.perViewKey.ttlMinutes = null;
        })().app.miris;
        expect(miris.perViewKey.ttlMinutes).toBe(15);
    });

    test("a perViewKey block without ttlMinutes gets 15", () => {
        const miris = resolve((c) => {
            c.app.miris.perViewKey = {};
        })().app.miris;
        expect(miris.perViewKey.ttlMinutes).toBe(15);
    });

    test("values the operator set are kept", () => {
        const miris = resolve((c) => {
            c.app.miris.mirisApiBaseUrl = "https://miris.example.test";
            c.app.miris.perViewKey.ttlMinutes = 30;
        })().app.miris;
        expect(miris.mirisApiBaseUrl).toBe("https://miris.example.test");
        expect(miris.perViewKey.ttlMinutes).toBe(30);
    });
});

describe("legacy app.miris.upload aliases", () => {
    test("a legacy apiKeySecretArn fills an absent app.miris.apiKeySecretArn and warns", () => {
        const miris = resolve((c) => {
            c.app.miris = legacyMirisBlock();
            c.app.miris.upload.apiKeySecretArn = SECRET_ARN;
        })().app.miris;
        expect(miris.apiKeySecretArn).toBe(SECRET_ARN);
        expect(miris.upload).not.toHaveProperty("apiKeySecretArn");
        expect(warnings()).toContainEqual(
            expect.stringMatching(/app\.miris\.upload\.apiKeySecretArn is deprecated/)
        );
    });

    test("a legacy apiKeySecretArn fills the template placeholder in app.miris.apiKeySecretArn", () => {
        const miris = resolve((c) => {
            c.app.miris.upload.apiKeySecretArn = SECRET_ARN;
        })().app.miris;
        expect(miris.apiKeySecretArn).toBe(SECRET_ARN);
    });

    test("a legacy mirisApiBaseUrl is used rather than the default", () => {
        const miris = resolve((c) => {
            c.app.miris = legacyMirisBlock();
            c.app.miris.upload.mirisApiBaseUrl = "https://miris.example.test";
        })().app.miris;
        expect(miris.mirisApiBaseUrl).toBe("https://miris.example.test");
        expect(miris.upload).not.toHaveProperty("mirisApiBaseUrl");
        expect(warnings()).toContainEqual(
            expect.stringMatching(/app\.miris\.upload\.mirisApiBaseUrl is deprecated/)
        );
    });

    test.each([
        ["apiKeySecretArn", SECRET_ARN, OTHER_SECRET_ARN],
        ["mirisApiBaseUrl", "https://app.miris.com", "https://miris.example.test"],
    ])("conflicting values for %s are rejected, naming both paths", (field, hoisted, legacy) => {
        const run = resolve((c) => {
            c.app.miris[field] = hoisted;
            c.app.miris.upload[field] = legacy;
        });
        expect(run).toThrow(
            new RegExp(
                `app\\.miris\\.${field} .*app\\.miris\\.upload\\.${field} .*both set and differ`
            )
        );
    });

    test.each([
        ["apiKeySecretArn", SECRET_ARN],
        ["mirisApiBaseUrl", "https://miris.example.test"],
    ])("an equal legacy %s is accepted with a warning and removed", (field, value) => {
        const miris: any = resolve((c) => {
            c.app.miris[field] = value;
            c.app.miris.upload[field] = value;
        })().app.miris;
        expect(miris[field]).toBe(value);
        expect(miris.upload).not.toHaveProperty(field);
        expect(warnings()).toContainEqual(
            expect.stringMatching(new RegExp(`app\\.miris\\.upload\\.${field} is deprecated`))
        );
    });

    test("a legacy placeholder is dropped without a warning", () => {
        const miris = resolve((c) => {
            c.app.miris.apiKeySecretArn = SECRET_ARN;
            c.app.miris.upload.apiKeySecretArn = "UNDEFINED";
        })().app.miris;
        expect(miris.apiKeySecretArn).toBe(SECRET_ARN);
        expect(miris.upload).not.toHaveProperty("apiKeySecretArn");
        expect(mirisWarnings()).toEqual([]);
    });

    test("a legacy secret satisfies the upload pipeline's secret requirement", () => {
        const miris = resolve((c) => {
            enableMiris(c);
            c.app.miris.upload.enabled = true;
            c.app.miris.upload.apiKeySecretArn = SECRET_ARN;
        })().app.miris;
        expect(miris.apiKeySecretArn).toBe(SECRET_ARN);
    });

    test("a legacy secret satisfies perView mode's secret requirement", () => {
        const miris = resolve((c) => {
            enablePerView(c);
            c.app.miris.apiKeySecretArn = "UNDEFINED";
            c.app.miris.upload.apiKeySecretArn = SECRET_ARN;
        })().app.miris;
        expect(miris.apiKeySecretArn).toBe(SECRET_ARN);
    });
});

describe("viewerKeyMode", () => {
    test("an unknown mode is rejected even with Miris disabled", () => {
        expect(
            resolve((c) => {
                c.app.miris.viewerKeyMode = "dynamic";
            })
        ).toThrow(/app\.miris\.viewerKeyMode must be one of "static", "perView"; got "dynamic"/);
    });

    test("the mode is case sensitive", () => {
        expect(
            resolve((c) => {
                c.app.miris.viewerKeyMode = "perview";
            })
        ).toThrow(/app\.miris\.viewerKeyMode must be one of/);
    });
});

describe("perViewKey.ttlMinutes", () => {
    test.each([1, 15, 60])("%p is accepted", (ttl) => {
        expect(
            resolve((c) => {
                c.app.miris.perViewKey.ttlMinutes = ttl;
            })().app.miris.perViewKey.ttlMinutes
        ).toBe(ttl);
    });

    test.each([0, 61, -5, 15.5, "15", true])("%p is rejected", (ttl) => {
        expect(
            resolve((c) => {
                c.app.miris.perViewKey.ttlMinutes = ttl;
            })
        ).toThrow(
            /app\.miris\.perViewKey\.ttlMinutes must be a whole number of minutes from 1 to 60/
        );
    });
});

describe("perView mode", () => {
    test("is accepted with a secret and no viewer key", () => {
        const miris = resolve(enablePerView)().app.miris;
        expect(miris.viewerKeyMode).toBe("perView");
        expect(mirisWarnings()).toEqual([]);
    });

    test.each(["UNDEFINED", ""])("is rejected when apiKeySecretArn is %p", (value) => {
        expect(
            resolve((c) => {
                enablePerView(c);
                c.app.miris.apiKeySecretArn = value;
            })
        ).toThrow(/app\.miris\.viewerKeyMode "perView" requires app\.miris\.apiKeySecretArn/);
    });

    test("ignores a configured viewer key, with a warning", () => {
        const miris = resolve((c) => {
            enablePerView(c);
            c.app.miris.viewerKey = VIEWER_KEY;
        })().app.miris;
        expect(miris.viewerKeyMode).toBe("perView");
        expect(warnings()).toContainEqual(
            expect.stringMatching(
                /app\.miris\.viewerKey is ignored when app\.miris\.viewerKeyMode is "perView"/
            )
        );
    });

    test("does not require a secret while Miris is disabled", () => {
        expect(
            resolve((c) => {
                c.app.miris.viewerKeyMode = "perView";
            })
        ).not.toThrow();
    });

    test("still rejects GovCloud", () => {
        expect(
            resolve((c) => {
                enablePerView(c);
                c.app.govCloud.enabled = true;
            })
        ).toThrow(/app\.miris\.enabled cannot be true when app\.govCloud\.enabled is true/);
    });

    test("still requires allowUnsafeEvalFeatures", () => {
        expect(
            resolve((c) => {
                enablePerView(c);
                c.app.webUi.allowUnsafeEvalFeatures = false;
            })
        ).toThrow(/app\.miris\.enabled requires app\.webUi\.allowUnsafeEvalFeatures = true/);
    });
});

describe("static mode", () => {
    test("is accepted with a viewer key and no secret", () => {
        const miris = resolve(enableMiris)().app.miris;
        expect(miris.viewerKeyMode).toBe("static");
        expect(miris.viewerKey).toBe(VIEWER_KEY);
        expect(mirisWarnings()).toEqual([]);
    });

    test.each(["UNDEFINED", "", "too-short"])("rejects viewerKey %p", (value) => {
        expect(
            resolve((c) => {
                enableMiris(c);
                c.app.miris.viewerKey = value;
            })
        ).toThrow(/app\.miris\.enabled requires app\.miris\.viewerKey/);
    });

    test("an explicit static mode behaves the same", () => {
        expect(
            resolve((c) => {
                enableMiris(c);
                c.app.miris.viewerKeyMode = "static";
                c.app.miris.viewerKey = "UNDEFINED";
            })
        ).toThrow(/app\.miris\.enabled requires app\.miris\.viewerKey/);
    });
});

describe("upload pipeline", () => {
    function enableUpload(c: any) {
        enableMiris(c);
        c.app.miris.upload.enabled = true;
        c.app.miris.apiKeySecretArn = SECRET_ARN;
    }

    test("is accepted with app.miris.apiKeySecretArn", () => {
        expect(resolve(enableUpload)().app.miris.apiKeySecretArn).toBe(SECRET_ARN);
    });

    test("names app.miris.apiKeySecretArn when the secret is missing", () => {
        expect(
            resolve((c) => {
                enableUpload(c);
                c.app.miris.apiKeySecretArn = "UNDEFINED";
            })
        ).toThrow(/app\.miris\.upload\.enabled requires app\.miris\.apiKeySecretArn to be set/);
    });

    test("names app.miris.mirisApiBaseUrl and its default when the base URL is empty", () => {
        expect(
            resolve((c) => {
                enableUpload(c);
                c.app.miris.mirisApiBaseUrl = "";
            })
        ).toThrow(
            /app\.miris\.upload\.enabled requires app\.miris\.mirisApiBaseUrl \(default https:\/\/app\.miris\.com\)/
        );
    });
});
