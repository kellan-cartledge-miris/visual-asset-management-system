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
import {
    ALB_LISTENER_ATTRIBUTE_MAX_BYTES,
    deployedCspBytes,
} from "../../lib/nestedStacks/staticWebApp/constructs/alb-s3-website-albDeploy-construct";
import commercialTemplate from "../../config/config.template.commercial.json";

/** Where Miris can be on: `getConfig()` rejects it with GovCloud, so only the commercial template applies. */
function policy(region: string, mirisEnabled: boolean, albWorstCase = false): string {
    const config = JSON.parse(JSON.stringify(commercialTemplate));
    config.env.region = region;
    config.app.miris = { ...(config.app.miris ?? {}), enabled: mirisEnabled };
    config.app.webUi.allowUnsafeEvalFeatures = mirisEnabled;
    if (albWorstCase) {
        config.app.useCloudFront.enabled = false;
        config.app.useAlb.enabled = true;
        config.app.useLocationService.enabled = true;
    }
    SetConfig(config);
    // The caller passes the Cognito hosted UI URL with its scheme and the API host without one.
    return generateContentSecurityPolicy(
        {} as never,
        `https://vamsfederated.auth.${region}.amazoncognito.com`,
        `abcde12345.execute-api.${region}.amazonaws.com`,
        config
    );
}

function scriptSrc(csp: string): string[] {
    const directive = csp.split(";").find((d) => d.trim().startsWith("script-src "));
    return (directive ?? "").trim().split(/\s+/).slice(1);
}

describe("Miris blob: script source in the CSP", () => {
    test("script-src lists blob: with Miris enabled and not with it disabled", () => {
        const on = scriptSrc(policy("us-east-1", true));
        const off = scriptSrc(policy("us-east-1", false));
        // Control: both policies parsed to a real script-src.
        expect(on).toContain("'self'");
        expect(off).toContain("'self'");
        expect(on.filter((source) => source === "blob:")).toHaveLength(1);
        expect(off).not.toContain("blob:");
    });

    test("the sources Miris adds to script-src are exactly 'unsafe-eval' and blob:", () => {
        const on = scriptSrc(policy("us-east-1", true));
        const off = scriptSrc(policy("us-east-1", false));
        expect(new Set(on.filter((source) => !off.includes(source)))).toEqual(
            new Set(["'unsafe-eval'", "blob:"])
        );
    });
});

/**
 * The ALB carries the policy in one listener attribute capped at 1 KB. Miris adds about 44 bytes (`blob:` and the `*.miris.com` hosts), about 58 with the
 * `'unsafe-eval'` that `allowUnsafeEvalFeatures` adds and Miris requires.
 * The documented boundary (security.md, "Policy size on the Application Load Balancer path") is that a
 * Miris deployment on the ALB with a federated Cognito domain and Location Service in a 14-character
 * region does not fit. Moving the boundary should be a decision, so these pin both sides of it.
 */
describe("Miris CSP size on the ALB path", () => {
    const bytes = (region: string, mirisEnabled: boolean) =>
        deployedCspBytes(policy(region, mirisEnabled, true));

    test("the worst case with Miris exceeds the attribute cap and fits without Miris", () => {
        expect(bytes("ap-southeast-1", true)).toBeGreaterThan(ALB_LISTENER_ATTRIBUTE_MAX_BYTES);
        expect(bytes("ap-southeast-1", false)).toBeLessThanOrEqual(
            ALB_LISTENER_ATTRIBUTE_MAX_BYTES
        );
    });

    test("the same combination in us-east-1 fits with Miris", () => {
        expect(bytes("us-east-1", true)).toBeLessThanOrEqual(ALB_LISTENER_ATTRIBUTE_MAX_BYTES);
    });
});
