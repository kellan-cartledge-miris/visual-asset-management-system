/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Miris web SDK loads part of its engine through a dynamic `import()` of a `blob:` script URL, which
 * `script-src` blocks unless the source is listed. The source is added only when `app.miris.enabled`, so
 * a deployment without Miris keeps the narrower policy.
 */

import { generateContentSecurityPolicy } from "../../lib/helper/security";
import { SetConfig } from "../../lib/helper/service-helper";
import commercialTemplate from "../../config/config.template.commercial.json";
import govcloudTemplate from "../../config/config.template.govcloud.json";
import eusovereignTemplate from "../../config/config.template.eusovereign.json";

/** The ALB delivers the whole policy as one listener attribute, which Elastic Load Balancing caps at 1 KB. */
const ALB_ATTRIBUTE_CAP_BYTES = 1024;

const TEMPLATES: Array<[string, unknown, string]> = [
    ["commercial", commercialTemplate, "us-east-1"],
    ["govcloud", govcloudTemplate, "us-gov-west-1"],
    ["eusovereign", eusovereignTemplate, "eusc-de-east-1"],
];

function policy(template: unknown, region: string, mirisEnabled: boolean): string {
    const config = JSON.parse(JSON.stringify(template));
    config.env.region = region;
    config.app.miris = { ...(config.app.miris ?? {}), enabled: mirisEnabled };
    config.app.webUi.allowUnsafeEvalFeatures = mirisEnabled;
    SetConfig(config);
    return generateContentSecurityPolicy(
        {} as never,
        "auth.example.com",
        "api.example.com",
        config
    );
}

function scriptSrc(csp: string): string[] {
    const directive = csp.split(";").find((d) => d.trim().startsWith("script-src "));
    return (directive ?? "").trim().split(/\s+/).slice(1);
}

describe("Miris blob: script source in the CSP", () => {
    test.each(TEMPLATES)(
        "%s: script-src lists blob: with Miris enabled and not with it disabled",
        (_name, template, region) => {
            const on = scriptSrc(policy(template, region, true));
            const off = scriptSrc(policy(template, region, false));
            // Control: both policies parsed to a real script-src.
            expect(on).toContain("'self'");
            expect(off).toContain("'self'");
            expect(on.filter((source) => source === "blob:")).toHaveLength(1);
            expect(off).not.toContain("blob:");
        }
    );

    test("enabling Miris adds blob: to script-src after the existing sources", () => {
        const on = scriptSrc(policy(commercialTemplate, "us-east-1", true));
        const off = scriptSrc(policy(commercialTemplate, "us-east-1", false));
        expect(on.filter((source) => !off.includes(source))).toEqual(["'unsafe-eval'", "blob:"]);
    });

    test.each(TEMPLATES)(
        "%s: the policy with Miris enabled stays under the ALB attribute cap",
        (_name, template, region) => {
            const bytes = Buffer.byteLength(policy(template, region, true), "utf8");
            expect(bytes).toBeLessThanOrEqual(ALB_ATTRIBUTE_CAP_BYTES);
        }
    );
});
