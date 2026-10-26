/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `app.miris.viewerKeyMode` decides what reaches the browser. In "static" mode the config Lambda
 * serves the deployment viewer key and MIRIS_STREAMING is the only Miris stream flag. In "perView"
 * mode VAMS mints a key per viewer open, so the config Lambda carries no viewer key and the
 * MIRIS_PER_VIEW_KEYS feature switch is recorded alongside MIRIS_STREAMING.
 */

import { Resource, SynthResult, synthTemplate } from "../support/templateSynth";

const CONFIG_HANDLER = "handlers.config.configService.lambda_handler";
const PLACEHOLDER_VIEWER_KEY = "test-placeholder-viewer-key-000000";
const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-miris-api-key-AbCdEf";

function enableMiris(viewerKeyMode: "static" | "perView") {
    return (c: any) => {
        c.app.webUi.allowUnsafeEvalFeatures = true;
        c.app.miris.enabled = true;
        c.app.miris.viewerKey = PLACEHOLDER_VIEWER_KEY;
        c.app.miris.viewerKeyMode = viewerKeyMode;
        c.app.miris.apiKeySecretArn = SECRET_ARN;
    };
}

function configFunctions(synth: SynthResult): Resource[] {
    return synth.where("AWS::Lambda::Function", (r) => r.properties.Handler === CONFIG_HANDLER);
}

function recordsFeature(synth: SynthResult, feature: string): boolean {
    return synth
        .ofType("Custom::AWS")
        .some((r) => JSON.stringify(r.properties.Create).includes(`-${feature}\\"`));
}

describe.each([
    ["static", true],
    ["perView", false],
] as const)("Miris enabled, viewerKeyMode %s", (mode, servesViewerKey) => {
    let synth: SynthResult;

    beforeAll(() => {
        synth = synthTemplate("commercial", {
            mutate: enableMiris(mode),
            mutateKey: `miris-viewer-key-mode-${mode}`,
        });
    });

    test("the config Lambda carries the viewer key only in static mode", () => {
        const fns = configFunctions(synth);
        expect(fns).toHaveLength(1);
        expect(fns[0].properties.Environment.Variables.MIRIS_VIEWER_KEY).toBe(
            servesViewerKey ? PLACEHOLDER_VIEWER_KEY : ""
        );
    });

    test("the MIRIS_PER_VIEW_KEYS switch is recorded only in perView mode", () => {
        expect(recordsFeature(synth, "MIRIS_STREAMING")).toBe(true);
        expect(recordsFeature(synth, "MIRIS_PER_VIEW_KEYS")).toBe(!servesViewerKey);
    });
});
