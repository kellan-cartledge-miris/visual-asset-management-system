/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The add-on `script-src` lane of the web Content-Security-Policy.
 *
 * `addonCspSources()` (`lib/nestedStacks/addon/addonCsp.ts`) returns the sources the enabled add-ons
 * need, and `generateContentSecurityPolicy()` (`lib/helper/security.ts`) merges its `scriptSrc` into
 * `script-src`. Each entry must be one source expression from a fixed set (keyword, hash or HTTPS/WSS
 * host source); anything else fails synthesis rather than being emitted or silently dropped. That
 * covers `'unsafe-inline'`, which the hash sources make inert, `'unsafe-eval'`, which only
 * `app.webUi.allowUnsafeEvalFeatures` adds, sources that allow script from any host, a nonce in a
 * static header, `'strict-dynamic'`, and an entry carrying `;` that would inject a directive ahead of
 * the core `object-src` and `frame-ancestors`, which browsers would honour instead.
 *
 * No shipped add-on contributes a script source, so the merge is exercised by replacing
 * `addonCspSources()` with a stand-in add-on. The policy is generated directly from each shipped
 * template rather than through a full-app synth: the function reads only the config and the
 * operator's `cspAdditionalConfig.json`.
 */

import * as fs from "fs";
import * as path from "path";
import * as Config from "../../config/config";
import * as Service from "../../lib/helper/service-helper";
import * as AddonCsp from "../../lib/nestedStacks/addon/addonCsp";
import { generateContentSecurityPolicy } from "../../lib/helper/security";
import { INDEX_HTML_INLINE_SCRIPT_HASHES } from "../../lib/helper/cspInlineScriptHashes";

const TEMPLATES: Record<string, { region: string; partition: string }> = {
    commercial: { region: "us-east-1", partition: "aws" },
    govcloud: { region: "us-gov-west-1", partition: "aws-us-gov" },
    eusovereign: { region: "eusc-de-east-1", partition: "aws-eusc" },
};

const CSP_ADDITIONS = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "config", "csp", "cspAdditionalConfig.json"), {
        encoding: "utf8",
    })
);

function templateConfig(name: string, mutate?: (c: any) => void): Config.Config {
    const config = JSON.parse(
        fs.readFileSync(
            path.join(__dirname, "..", "..", "config", `config.template.${name}.json`),
            "utf8"
        )
    );
    config.env.account = "123456789012";
    config.env.region = TEMPLATES[name].region;
    config.env.partition = TEMPLATES[name].partition;
    mutate?.(config);
    return config as Config.Config;
}

function policy(config: Config.Config): string {
    Service.SetConfig(config);
    return generateContentSecurityPolicy(
        {} as any,
        "https://auth.example.com",
        "api.example.com",
        config
    );
}

function directive(csp: string, name: string): string[] {
    const found = csp
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name} `));
    if (!found) throw new Error(`no ${name} directive in: ${csp}`);
    return found.split(/\s+/).slice(1);
}

/** Every directive except the one named, for checking that a merge touched only its own. */
function otherDirectives(csp: string, name: string): string[] {
    return csp
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !part.startsWith(`${name} `));
}

/** Replaces the add-on sources with a stand-in add-on that contributes the given script sources. */
function withAddonScriptSrc(scriptSrc: string[]): void {
    jest.spyOn(AddonCsp, "addonCspSources").mockReturnValue({
        connectSrc: [],
        frameSrc: [],
        scriptSrc,
    });
}

const silenceConfigLog = () => jest.spyOn(console, "log").mockImplementation(() => undefined);

describe("add-on script-src lane", () => {
    beforeEach(() => {
        silenceConfigLog();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe.each(Object.keys(TEMPLATES))("%s template", (name) => {
        it("contributes no add-on source with every add-on off", () => {
            expect(AddonCsp.addonCspSources(templateConfig(name))).toEqual({
                connectSrc: [],
                frameSrc: [],
                scriptSrc: [],
            });
        });

        it("emits only the core script-src sources with every add-on off", () => {
            // The core sources, the gated 'unsafe-eval' and the operator's additions, in that
            // order: anything else in the directive came from the add-on lane.
            for (const unsafeEval of [false, true]) {
                const config = templateConfig(name, (c) => {
                    c.app.webUi.allowUnsafeEvalFeatures = unsafeEval;
                });
                const expected = [
                    "'self'",
                    "'unsafe-hashes'",
                    "'wasm-unsafe-eval'",
                    ...INDEX_HTML_INLINE_SCRIPT_HASHES,
                    ...(unsafeEval ? ["'unsafe-eval'"] : []),
                ];
                for (const extra of CSP_ADDITIONS.scriptSrc ?? []) {
                    if (!expected.includes(extra)) expected.push(extra);
                }
                expect(directive(policy(config), "script-src")).toEqual(expected);
            }
        });

        it("adds no script source for the Physna add-on", () => {
            const config = templateConfig(name, (c) => {
                c.app.addons.usePhysnaSync.enabled = true;
                c.app.addons.usePhysnaSync.apiBaseEndpoint = "https://tenant.physna.example/api";
            });
            expect(AddonCsp.addonCspSources(config).scriptSrc).toEqual([]);
            expect(directive(policy(config), "script-src")).toEqual(
                directive(policy(templateConfig(name)), "script-src")
            );
        });

        it("merges an add-on script source into script-src and nowhere else", () => {
            const config = templateConfig(name);
            const before = policy(config);

            withAddonScriptSrc(["blob:", "https://cdn.addon.example"]);
            const after = policy(config);

            expect(directive(after, "script-src")).toEqual([
                ...directive(before, "script-src"),
                "blob:",
                "https://cdn.addon.example",
            ]);
            expect(otherDirectives(after, "script-src")).toEqual(
                otherDirectives(before, "script-src")
            );
        });

        it("does not repeat a source script-src already carries", () => {
            const config = templateConfig(name);
            const before = directive(policy(config), "script-src");

            withAddonScriptSrc(["'self'", "https://cdn.addon.example"]);

            expect(directive(policy(config), "script-src")).toEqual([
                ...before,
                "https://cdn.addon.example",
            ]);
        });
    });

    describe("entries the lane refuses", () => {
        const refused: Array<[string, string]> = [
            ["empty entry", ""],
            ["source list in one entry", "https://cdn.addon.example 'unsafe-inline'"],
            ["source list split by a tab", "blob:\thttps://cdn.addon.example"],
            ["trailing newline", "blob:\n"],
            ["trailing ';' after a refused keyword", "'unsafe-eval';"],
            ["trailing ';' after an accepted source", "blob:;"],
            ["object-src injection", "blob:; object-src *"],
            ["leading object-src injection", "; object-src *"],
            ["frame-ancestors injection", "; frame-ancestors *"],
            ["comma-joined sources", "blob:,https://cdn.addon.example"],
            ["'unsafe-inline'", "'unsafe-inline'"],
            ["unquoted unsafe-inline", "unsafe-inline"],
            ["upper-case 'UNSAFE-INLINE'", "'UNSAFE-INLINE'"],
            ["'unsafe-eval'", "'unsafe-eval'"],
            ["unquoted unsafe-eval", "unsafe-eval"],
            ["mixed-case 'Unsafe-Eval'", "'Unsafe-Eval'"],
            ["wildcard", "*"],
            ["scheme-only https:", "https:"],
            ["scheme-only HTTPS:", "HTTPS:"],
            ["scheme-only http:", "http:"],
            ["scheme-only data:", "data:"],
            ["nonce", "'nonce-abc123'"],
            ["upper-case nonce", "'NONCE-abc123'"],
            ["'strict-dynamic'", "'strict-dynamic'"],
            ["upper-case 'STRICT-DYNAMIC'", "'STRICT-DYNAMIC'"],
            ["wildcard host", "https://*"],
            ["plain-http host", "http://cdn.addon.example"],
            ["host without a scheme", "cdn.addon.example"],
            ["unquoted keyword", "self"],
            ["unknown keyword", "'report-sample'"],
            ["hash of an unsupported algorithm", "'sha1-AAAA'"],
        ];

        it.each(refused)("refuses %s", (_label, entry) => {
            withAddonScriptSrc(["blob:", entry]);
            expect(() => policy(templateConfig("commercial"))).toThrow(
                /^Add-on CSP: .* in scriptSrc is not accepted: /
            );
        });

        it("refuses 'unsafe-eval' even when allowUnsafeEvalFeatures already adds it", () => {
            withAddonScriptSrc(["'unsafe-eval'"]);
            const config = templateConfig("commercial", (c) => {
                c.app.webUi.allowUnsafeEvalFeatures = true;
            });
            expect(() => policy(config)).toThrow(
                /"'unsafe-eval'" in scriptSrc is not accepted: .*allowUnsafeEvalFeatures/
            );
        });
    });

    describe("entries the lane accepts", () => {
        const accepted: Array<[string, string]> = [
            ["blob:", "blob:"],
            ["upper-case BLOB:", "BLOB:"],
            ["'self'", "'self'"],
            ["'unsafe-hashes'", "'unsafe-hashes'"],
            ["'wasm-unsafe-eval'", "'wasm-unsafe-eval'"],
            ["sha256 hash", "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='"],
            [
                "sha384 hash",
                "'sha384-OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb'",
            ],
            [
                "sha512 hash",
                "'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=='",
            ],
            ["https host", "https://cdn.addon.example"],
            ["https wildcard subdomain", "https://*.addon.example"],
            ["https host with port and path", "https://cdn.addon.example:8443/sdk/v1/"],
            ["wss host", "wss://stream.addon.example"],
            ["wss wildcard subdomain", "wss://*.addon.example"],
        ];

        it.each(accepted)("accepts %s", (_label, entry) => {
            withAddonScriptSrc([entry]);
            const csp = policy(templateConfig("commercial"));
            const scriptSrc = directive(csp, "script-src");
            // Already present core sources are not repeated; anything new is appended as given.
            expect(scriptSrc.filter((source) => source === entry).length).toBeLessThanOrEqual(1);
            expect(scriptSrc.map((source) => source.toLowerCase())).toContain(entry.toLowerCase());
            expect(directive(csp, "object-src")).toEqual(["'none'"]);
            expect(directive(csp, "frame-ancestors")).toEqual(["'self'"]);
        });

        it("does not read 'wasm-unsafe-eval' as 'unsafe-eval'", () => {
            // Control for the token match: a substring test would refuse this core keyword.
            withAddonScriptSrc(["'wasm-unsafe-eval'", "blob:"]);
            const csp = policy(templateConfig("commercial"));
            expect(directive(csp, "script-src")).toContain("blob:");
            expect(directive(csp, "script-src")).not.toContain("'unsafe-eval'");
        });
    });
});
