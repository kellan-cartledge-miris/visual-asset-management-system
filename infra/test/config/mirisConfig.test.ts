/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `getConfig()` rules for `app.miris`: defaults, the legacy `app.miris.upload.apiKeySecretArn` and
 * `app.miris.upload.mirisApiBaseUrl` aliases, the viewer key mode, the per-view key lifetime, the
 * viewer key and Integration Key secret ARN formats, the upload pipeline settings, and the outbound
 * check on `app.miris.mirisApiBaseUrl`. The ConfigBuilder's hand-ported rules are asserted from the
 * same cases.
 *
 * Every rejection asserts on the MESSAGE. A Miris config can be invalid in several ways at once, so a
 * bare `.toThrow()` would pass while the rule under test did nothing.
 */

import * as fs from "fs";
import * as Config from "../../config/config";
import commercialTemplate from "../../config/config.template.commercial.json";
import { newTestApp } from "../support/testApp";
import mirisStreamSchema from "../../lib/nestedStacks/apiLambda/constructs/dynamodb-metadataschema-miris-stream.json";
import {
    evaluateRules,
    MIRIS_STREAM_SCHEMA_EXTENSIONS,
} from "../../../documentation/docusaurus-site/src/components/ConfigBuilder/validation";

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

/** The upload pipeline runs on AWS Batch in the global VPC's private subnets. */
function enableUpload(c: any) {
    enableMiris(c);
    c.app.useGlobalVpc.enabled = true;
    c.app.miris.upload.enabled = true;
    c.app.miris.apiKeySecretArn = SECRET_ARN;
}

/** The ConfigBuilder rule ids reported for a config built from the commercial template. */
function builderRules(mutate: (c: any) => void, prefix: string): string[] {
    const config = JSON.parse(JSON.stringify(commercialTemplate));
    mutate(config);
    return evaluateRules(config)
        .map((rule) => rule.id)
        .filter((id) => id.startsWith(prefix));
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
            enableUpload(c);
            c.app.miris.apiKeySecretArn = "UNDEFINED";
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

    test.each(["UNDEFINED", ""])("rejects an unset viewerKey %p", (value) => {
        const mutate = (c: any) => {
            enableMiris(c);
            c.app.miris.viewerKey = value;
        };
        expect(resolve(mutate)).toThrow(/app\.miris\.enabled requires app\.miris\.viewerKey/);
        expect(builderRules(mutate, "miris-viewerkey-")).toEqual(["miris-viewerkey-required"]);
    });

    test("rejects a viewer key shorter than 16 characters with its own message", () => {
        const mutate = (c: any) => {
            enableMiris(c);
            c.app.miris.viewerKey = "too-short";
        };
        expect(resolve(mutate)).toThrow(
            /app\.miris\.viewerKey is 9 characters long; a Miris viewer key is at least 16/
        );
        expect(builderRules(mutate, "miris-viewerkey-")).toEqual(["miris-viewerkey-short"]);
    });

    test("accepts a viewer key of exactly 16 characters", () => {
        const mutate = (c: any) => {
            enableMiris(c);
            c.app.miris.viewerKey = "0123456789abcdef";
        };
        expect(resolve(mutate)().app.miris.viewerKey).toBe("0123456789abcdef");
        expect(builderRules(mutate, "miris-viewerkey-")).toEqual([]);
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
    test("is accepted with app.miris.apiKeySecretArn", () => {
        expect(resolve(enableUpload)().app.miris.apiKeySecretArn).toBe(SECRET_ARN);
        expect(builderRules(enableUpload, "miris-")).toEqual([]);
        expect(builderRules(enableUpload, "vpc-")).toEqual([]);
    });

    test("requires the global VPC", () => {
        const mutate = (c: any) => {
            enableUpload(c);
            c.app.useGlobalVpc.enabled = false;
        };
        expect(resolve(mutate)).toThrow(
            /app\.useGlobalVpc\.enabled must be true because the following enabled feature\(s\) require a VPC: miris\.upload\./
        );
        expect(builderRules(mutate, "vpc-required-")).toEqual(["vpc-required-miris-upload"]);
    });

    test("does not require the global VPC while disabled", () => {
        const mutate = (c: any) => {
            enableMiris(c);
            c.app.miris.upload.enabled = false;
        };
        expect(resolve(mutate)().app.useGlobalVpc.enabled).toBe(false);
        expect(builderRules(mutate, "vpc-required-")).toEqual([]);
    });

    test("requires a private subnet in an external VPC", () => {
        const mutate = (c: any) => {
            enableUpload(c);
            c.app.useGlobalVpc.optionalExternalVpcId = "vpc-0123456789abcdef0";
            c.app.useGlobalVpc.optionalExternalIsolatedSubnetIds = "subnet-0123456789abcdef0";
        };
        expect(resolve(mutate)).toThrow(
            /Must define at least one private subnet ID when using a pipeline that requires private subnets/
        );
        expect(builderRules(mutate, "vpc-private-subnets")).toEqual(["vpc-private-subnets"]);
    });

    test("requires allowUnsafeEvalFeatures through the viewer's own rule", () => {
        const mutate = (c: any) => {
            enableUpload(c);
            c.app.webUi.allowUnsafeEvalFeatures = false;
        };
        expect(resolve(mutate)).toThrow(
            /app\.miris\.enabled requires app\.webUi\.allowUnsafeEvalFeatures = true/
        );
        expect(builderRules(mutate, "miris-")).toEqual(["miris-unsafe-eval"]);
    });

    test("names app.miris.apiKeySecretArn when the secret is missing", () => {
        expect(
            resolve((c) => {
                enableUpload(c);
                c.app.miris.apiKeySecretArn = "UNDEFINED";
            })
        ).toThrow(/app\.miris\.upload\.enabled requires app\.miris\.apiKeySecretArn to be set/);
    });

    test("an empty base URL gets the default", () => {
        const miris = resolve((c) => {
            enableUpload(c);
            c.app.miris.mirisApiBaseUrl = "";
        })().app.miris;
        expect(miris.mirisApiBaseUrl).toBe("https://app.miris.com");
    });
});

describe("upload settings", () => {
    test("each missing upload field is filled on its own", () => {
        const upload = resolve((c) => {
            c.app.miris.upload = { enabled: false, taskTimeoutSeconds: 900 };
        })().app.miris.upload;
        expect(upload).toEqual({
            enabled: false,
            autoRegisterWithVAMS: true,
            autoRegisterAutoTriggerOnFileUpload: true,
            triggerExtensions: ".usd,.usda,.usdc,.usdz",
            taskTimeoutSeconds: 900,
            maxAssetSizeBytes: 5_000_000_000,
        });
    });

    test("an enabled upload block with only enabled set is valid", () => {
        const mutate = (c: any) => {
            enableUpload(c);
            c.app.miris.upload = { enabled: true };
        };
        expect(resolve(mutate)().app.miris.upload.taskTimeoutSeconds).toBe(1800);
        expect(builderRules(mutate, "miris-upload-")).toEqual([]);
    });

    test("a false autoRegisterWithVAMS is kept", () => {
        const upload = resolve((c) => {
            c.app.miris.upload = { enabled: false, autoRegisterWithVAMS: false };
        })().app.miris.upload;
        expect(upload.autoRegisterWithVAMS).toBe(false);
        expect(upload.autoRegisterAutoTriggerOnFileUpload).toBe(true);
    });

    describe.each([
        ["taskTimeoutSeconds", "miris-upload-task-timeout"],
        ["maxAssetSizeBytes", "miris-upload-max-asset-size"],
    ])("%s", (field, ruleId) => {
        test.each([1, 1800, 5_000_000_000])("%p is accepted", (value) => {
            const mutate = (c: any) => {
                enableUpload(c);
                c.app.miris.upload[field] = value;
            };
            expect((resolve(mutate)().app.miris.upload as any)[field]).toBe(value);
            expect(builderRules(mutate, "miris-upload-")).toEqual([]);
        });

        test.each([0, -1, 1.5, "1800", true])("%p is rejected", (value) => {
            const mutate = (c: any) => {
                enableUpload(c);
                c.app.miris.upload[field] = value;
            };
            expect(resolve(mutate)).toThrow(
                new RegExp(`app\\.miris\\.upload\\.${field} must be a positive whole number`)
            );
            expect(builderRules(mutate, "miris-upload-")).toEqual([ruleId]);
        });

        test("is not validated while the upload pipeline is disabled", () => {
            const mutate = (c: any) => {
                enableMiris(c);
                c.app.miris.upload[field] = 0;
            };
            expect(resolve(mutate)).not.toThrow();
            expect(builderRules(mutate, "miris-upload-")).toEqual([]);
        });
    });

    describe("triggerExtensions", () => {
        test.each([".usd", ".usdz,.usd", ".usd, .usda", ".usd,.usda,.usdc,.usdz"])(
            "%p is accepted",
            (value) => {
                const mutate = (c: any) => {
                    enableUpload(c);
                    c.app.miris.upload.triggerExtensions = value;
                };
                expect(resolve(mutate)().app.miris.upload.triggerExtensions).toBe(value);
                expect(builderRules(mutate, "miris-upload-")).toEqual([]);
            }
        );

        test.each(["", " ", "usd", ".USD", ".usd,", ".usd,,.usdz", "*.usd", [".usd"], 5])(
            "%p is rejected as malformed",
            (value) => {
                const mutate = (c: any) => {
                    enableUpload(c);
                    c.app.miris.upload.triggerExtensions = value;
                };
                expect(resolve(mutate)).toThrow(
                    /app\.miris\.upload\.triggerExtensions must be a comma-separated list of lowercase file extensions/
                );
                expect(builderRules(mutate, "miris-upload-")).toEqual([
                    "miris-upload-trigger-extensions-format",
                ]);
            }
        );

        test.each([".glb", ".usd,.obj"])(
            "%p is rejected as outside the Miris stream metadata schema",
            (value) => {
                const mutate = (c: any) => {
                    enableUpload(c);
                    c.app.miris.upload.triggerExtensions = value;
                };
                expect(resolve(mutate)).toThrow(
                    /app\.miris\.upload\.triggerExtensions may only list extensions the Miris stream file metadata schema accepts \(\.usd, \.usda, \.usdc, \.usdz\)/
                );
                expect(builderRules(mutate, "miris-upload-")).toEqual([
                    "miris-upload-trigger-extensions-schema",
                ]);
            }
        );

        test("is not validated while the upload pipeline is disabled", () => {
            const mutate = (c: any) => {
                enableMiris(c);
                c.app.miris.upload.triggerExtensions = ".glb";
            };
            expect(resolve(mutate)).not.toThrow();
            expect(builderRules(mutate, "miris-upload-")).toEqual([]);
        });

        test("the ConfigBuilder's extension list matches the metadata schema", () => {
            expect(MIRIS_STREAM_SCHEMA_EXTENSIONS).toEqual(
                mirisStreamSchema.fileKeyTypeRestriction.split(",")
            );
        });
    });
});

describe("apiKeySecretArn format", () => {
    const VALID = [
        SECRET_ARN,
        "arn:aws-us-gov:secretsmanager:us-gov-west-1:123456789012:secret:miris/integration_key-AbCdEf",
        "arn:aws-cn:secretsmanager:cn-north-1:123456789012:secret:miris-key-0a1B2c",
    ];
    const INVALID = [
        // A partial ARN, without the suffix Secrets Manager appends, does not match the IAM grant.
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:miris-integration-key",
        "miris-integration-key",
        "arn:aws:secretsmanager:us-east-1:123456789012:miris-integration-key-AbCdEf",
        "arn:aws:s3:::miris-integration-key-AbCdEf",
        "arn:aws:secretsmanager:us-east-1:12345:secret:miris-integration-key-AbCdEf",
    ];

    test.each(VALID)("%p is accepted for the upload pipeline and perView mode", (arn) => {
        for (const enable of [enableUpload, enablePerView]) {
            const mutate = (c: any) => {
                enable(c);
                c.app.miris.apiKeySecretArn = arn;
            };
            expect(resolve(mutate)().app.miris.apiKeySecretArn).toBe(arn);
            expect(builderRules(mutate, "miris-secret-")).toEqual([]);
        }
    });

    test.each(INVALID)("%p is rejected for the upload pipeline and perView mode", (arn) => {
        for (const enable of [enableUpload, enablePerView]) {
            const mutate = (c: any) => {
                enable(c);
                c.app.miris.apiKeySecretArn = arn;
            };
            expect(resolve(mutate)).toThrow(
                /app\.miris\.apiKeySecretArn must be the complete ARN of a Secrets Manager secret/
            );
            expect(builderRules(mutate, "miris-secret-")).toEqual(["miris-secret-arn-format"]);
        }
    });

    test("is not validated in static mode without the upload pipeline, where it is unused", () => {
        const mutate = (c: any) => {
            enableMiris(c);
            c.app.miris.apiKeySecretArn = "miris-integration-key";
        };
        expect(resolve(mutate)).not.toThrow();
        expect(builderRules(mutate, "miris-secret-")).toEqual([]);
    });
});

describe("mirisApiBaseUrl", () => {
    /** The ConfigBuilder rule ids reported for a config, restricted to the base URL rules. */
    function builderBaseUrlRules(mutate: (c: any) => void): string[] {
        const config = JSON.parse(JSON.stringify(commercialTemplate));
        mutate(config);
        return evaluateRules(config)
            .map((rule) => rule.id)
            .filter((id) => id.startsWith("miris-baseurl-"));
    }

    test.each(["UNDEFINED", ""])(
        "a hoisted %p is treated as unset and gets the default",
        (value) => {
            const miris = resolve((c) => {
                enableMiris(c);
                c.app.miris.mirisApiBaseUrl = value;
            })().app.miris;
            expect(miris.mirisApiBaseUrl).toBe("https://app.miris.com");
            expect(
                builderBaseUrlRules((c) => {
                    enableMiris(c);
                    c.app.miris.mirisApiBaseUrl = value;
                })
            ).toEqual([]);
        }
    );

    test("https://app.miris.com is accepted while Miris is enabled", () => {
        const mutate = (c: any) => {
            enablePerView(c);
            c.app.miris.mirisApiBaseUrl = "https://app.miris.com";
        };
        expect(resolve(mutate)().app.miris.mirisApiBaseUrl).toBe("https://app.miris.com");
        expect(builderBaseUrlRules(mutate)).toEqual([]);
    });

    test("the instance metadata endpoint is rejected while Miris is enabled", () => {
        const mutate = (c: any) => {
            enableMiris(c);
            c.app.miris.mirisApiBaseUrl = "https://169.254.169.254";
        };
        expect(resolve(mutate)).toThrow(
            /app\.miris\.mirisApiBaseUrl resolves to a loopback, link-local, or private address/
        );
        expect(builderBaseUrlRules(mutate)).toEqual(["miris-baseurl-private-host"]);
    });

    test("plain http is rejected while Miris is enabled", () => {
        const mutate = (c: any) => {
            enableMiris(c);
            c.app.miris.mirisApiBaseUrl = "http://169.254.169.254";
        };
        expect(resolve(mutate)).toThrow(/app\.miris\.mirisApiBaseUrl must use https/);
        expect(builderBaseUrlRules(mutate)).toEqual(
            expect.arrayContaining(["miris-baseurl-https"])
        );
    });

    test("an unparseable URL is rejected while Miris is enabled", () => {
        const mutate = (c: any) => {
            enableMiris(c);
            c.app.miris.mirisApiBaseUrl = "app.miris.com";
        };
        expect(resolve(mutate)).toThrow(/app\.miris\.mirisApiBaseUrl must be a valid URL/);
        expect(builderBaseUrlRules(mutate)).toEqual(["miris-baseurl-url"]);
    });

    test("is not validated while Miris is disabled", () => {
        const mutate = (c: any) => {
            c.app.miris.enabled = false;
            c.app.miris.mirisApiBaseUrl = "http://169.254.169.254";
        };
        expect(resolve(mutate)().app.miris.mirisApiBaseUrl).toBe("http://169.254.169.254");
        expect(builderBaseUrlRules(mutate)).toEqual([]);
    });
});
