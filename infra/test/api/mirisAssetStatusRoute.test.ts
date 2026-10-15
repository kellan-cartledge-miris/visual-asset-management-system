/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Miris stream status route deploys with `app.miris.enabled`, independent of the upload pipeline.
 *
 * The handler reads the stream's Miris asset UUID from the viewed file's metadata, so it serves streams
 * that were recorded by hand on deployments without the upload pipeline. It authenticates its probe with
 * the deployment viewer key (always present when Miris is enabled) and never with the upload pipeline's
 * Integration Key, so its Lambda carries no Secrets Manager access in either configuration. Its table
 * access is read-only.
 */

import { Resource, SynthResult, synthTemplate } from "../support/templateSynth";

const STATUS_ROUTE = "/database/{databaseId}/assets/{assetId}/miris/asset-status";
const STATUS_HANDLER = "handlers.miris.getAssetStatus.lambda_handler";
const PLACEHOLDER_VIEWER_KEY = "test-placeholder-viewer-key-000000";

function enableMiris(c: any) {
    c.app.webUi.allowUnsafeEvalFeatures = true;
    c.app.miris.enabled = true;
    c.app.miris.viewerKey = PLACEHOLDER_VIEWER_KEY;
}

function enableMirisWithUpload(c: any) {
    enableMiris(c);
    // The upload pipeline runs on AWS Batch, which needs the global VPC.
    c.app.useGlobalVpc.enabled = true;
    c.app.miris.upload.enabled = true;
    c.app.miris.upload.autoRegisterAutoTriggerOnFileUpload = false;
    c.app.miris.apiKeySecretArn =
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-miris-api-key-AbCdEf";
}

function restApiPaths(synth: SynthResult): Record<string, Record<string, unknown>> {
    const apis = synth.ofType("AWS::ApiGateway::RestApi");
    expect(apis).toHaveLength(1);
    return (apis[0].properties as any).Body.paths;
}

function statusFunctions(synth: SynthResult): Resource[] {
    return synth.where("AWS::Lambda::Function", (r) => r.properties.Handler === STATUS_HANDLER);
}

/** Every IAM statement attached to the status Lambda's execution role. */
function statusRoleStatements(synth: SynthResult): any[] {
    const [fn] = statusFunctions(synth);
    const roleLogicalId = fn.properties.Role["Fn::GetAtt"][0];
    return synth
        .where(
            "AWS::IAM::Policy",
            (p) =>
                p.stack === fn.stack &&
                (p.properties.Roles ?? []).some((role: any) => role?.Ref === roleLogicalId)
        )
        .flatMap((p) => p.properties.PolicyDocument.Statement as any[]);
}

function actionsOf(statements: any[]): string[] {
    return statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
}

describe("Miris disabled (stock commercial template)", () => {
    let synth: SynthResult;

    beforeAll(() => {
        synth = synthTemplate("commercial");
    });

    test("[control] the REST API has paths", () => {
        expect(Object.keys(restApiPaths(synth)).length).toBeGreaterThan(50);
    });

    test("neither the route nor its Lambda is deployed", () => {
        expect(restApiPaths(synth)[STATUS_ROUTE]).toBeUndefined();
        expect(statusFunctions(synth)).toHaveLength(0);
    });
});

describe.each([
    ["Miris enabled, upload pipeline disabled", "miris-status-stream-only", enableMiris],
    ["Miris enabled, upload pipeline enabled", "miris-status-with-upload", enableMirisWithUpload],
])("%s", (_label, mutateKey, mutate) => {
    let synth: SynthResult;

    beforeAll(() => {
        synth = synthTemplate("commercial", { mutate, mutateKey });
    });

    test("the status route is registered with a filePath-only shape", () => {
        const paths = restApiPaths(synth);
        expect(paths[STATUS_ROUTE]).toBeDefined();
        expect(Object.keys(paths[STATUS_ROUTE])).toContain("get");
        expect(Object.keys(paths).filter((p) => p.includes("mirisAssetUuid"))).toEqual([]);
    });

    test("exactly one status Lambda is deployed, with the viewer key and no secret", () => {
        const fns = statusFunctions(synth);
        expect(fns).toHaveLength(1);
        const variables = fns[0].properties.Environment?.Variables ?? {};
        expect(variables.MIRIS_VIEWER_KEY).toBe(PLACEHOLDER_VIEWER_KEY);
        expect(variables.MIRIS_API_BASE_URL).toBe("https://app.miris.com");
        expect(Object.keys(variables).filter((k) => /SECRET/i.test(k))).toEqual([]);
        // Table names resolve through SSM, not per-table environment variables.
        expect(variables.VAMS_RESOURCE_PARAM_PREFIX).toBeDefined();
        expect(Object.keys(variables).filter((k) => k.endsWith("_TABLE_NAME"))).toEqual([]);
    });

    test("the status Lambda has no Secrets Manager access", () => {
        const actions = actionsOf(statusRoleStatements(synth));
        expect(actions.length).toBeGreaterThan(0);
        expect(actions.filter((a) => a.toLowerCase().startsWith("secretsmanager:"))).toEqual([]);
    });

    test("the status Lambda reads, and cannot write, the asset and file metadata tables", () => {
        const statements = statusRoleStatements(synth);
        const actions = actionsOf(statements);
        expect(actions).toContain("dynamodb:GetItem");
        const writes = actions.filter((a) =>
            /^dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem|\*)$/.test(a)
        );
        expect(writes).toEqual([]);

        const dynamoResources = JSON.stringify(
            statements.filter((s) => actionsOf([s]).includes("dynamodb:GetItem"))
        );
        expect(dynamoResources).toMatch(/AssetStorageTable/);
        expect(dynamoResources).toMatch(/AssetFileMetadataStorageTableV2/);
    });
});
