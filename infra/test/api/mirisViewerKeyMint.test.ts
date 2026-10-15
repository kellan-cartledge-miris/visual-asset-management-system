/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In Miris "perView" mode VAMS mints a viewer key per viewer open, and no deployment-wide viewer key
 * exists anywhere.
 *
 * The mint route `POST /database/{databaseId}/assets/{assetId}/miris/viewer-key` and its Lambda deploy
 * only in perView mode. The mint Lambda reads exactly the configured Integration Key secret, reads the
 * asset and file metadata tables, and can only put rows into MirisViewerKeyStorageTable. The status
 * Lambda carries no viewer key in perView mode and reads the asset state with the Integration Key, so
 * it gains the same exact-ARN secret grant. In "static" mode neither the route nor the mint Lambda is
 * deployed and the status Lambda keeps the viewer key and has no Secrets Manager access.
 */

import { Resource, SynthResult, synthTemplate } from "../support/templateSynth";

const MINT_ROUTE = "/database/{databaseId}/assets/{assetId}/miris/viewer-key";
const STATUS_ROUTE = "/database/{databaseId}/assets/{assetId}/miris/asset-status";
const MINT_HANDLER = "handlers.miris.mintViewerKey.lambda_handler";
const STATUS_HANDLER = "handlers.miris.getAssetStatus.lambda_handler";
const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-miris-api-key-AbCdEf";
const PLACEHOLDER_VIEWER_KEY = "test-placeholder-viewer-key-000000";

function enableMiris(viewerKeyMode: "static" | "perView") {
    return (c: any) => {
        c.app.webUi.allowUnsafeEvalFeatures = true;
        c.app.miris.enabled = true;
        c.app.miris.viewerKeyMode = viewerKeyMode;
        c.app.miris.viewerKey = viewerKeyMode === "static" ? PLACEHOLDER_VIEWER_KEY : "UNDEFINED";
        c.app.miris.apiKeySecretArn = SECRET_ARN;
        c.app.miris.perViewKey = { ttlMinutes: 7 };
    };
}

function restApiPaths(synth: SynthResult): Record<string, Record<string, unknown>> {
    const apis = synth.ofType("AWS::ApiGateway::RestApi");
    expect(apis).toHaveLength(1);
    return (apis[0].properties as any).Body.paths;
}

function functionsWithHandler(synth: SynthResult, handler: string): Resource[] {
    return synth.where("AWS::Lambda::Function", (r) => r.properties.Handler === handler);
}

/** Every IAM statement attached to the execution role of the one Lambda with `handler`. */
function roleStatements(synth: SynthResult, handler: string): any[] {
    const [fn] = functionsWithHandler(synth, handler);
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

function actionsOf(statement: any): string[] {
    return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

function secretStatements(statements: any[]): any[] {
    return statements.filter((s) => actionsOf(s).some((a) => a.startsWith("secretsmanager:")));
}

function expectExactSecretGrant(statements: any[]) {
    const secrets = secretStatements(statements);
    expect(secrets).toHaveLength(1);
    expect(secrets[0].Effect).toBe("Allow");
    expect(actionsOf(secrets[0])).toEqual(["secretsmanager:GetSecretValue"]);
    expect(secrets[0].Resource).toBe(SECRET_ARN);
}

describe("Miris enabled, viewerKeyMode static", () => {
    let synth: SynthResult;

    beforeAll(() => {
        synth = synthTemplate("commercial", {
            mutate: enableMiris("static"),
            mutateKey: "miris-viewer-key-mint-static",
        });
    });

    test("[control] the status route and Lambda are deployed", () => {
        expect(restApiPaths(synth)[STATUS_ROUTE]).toBeDefined();
        expect(functionsWithHandler(synth, STATUS_HANDLER)).toHaveLength(1);
    });

    test("neither the mint route nor the mint Lambda is deployed", () => {
        expect(restApiPaths(synth)[MINT_ROUTE]).toBeUndefined();
        expect(functionsWithHandler(synth, MINT_HANDLER)).toHaveLength(0);
        expect(synth.grep("MirisMintViewerKey")).toEqual([]);
    });

    test("the status Lambda keeps the viewer key and has no Secrets Manager access", () => {
        const [fn] = functionsWithHandler(synth, STATUS_HANDLER);
        const env = fn.properties.Environment.Variables;
        expect(env.MIRIS_VIEWER_KEY_MODE).toBe("static");
        expect(env.MIRIS_VIEWER_KEY).toBe(PLACEHOLDER_VIEWER_KEY);
        expect(env).not.toHaveProperty("MIRIS_API_KEY_SECRET_ARN");
        expect(secretStatements(roleStatements(synth, STATUS_HANDLER))).toEqual([]);
    });
});

describe("Miris enabled, viewerKeyMode perView", () => {
    let synth: SynthResult;

    beforeAll(() => {
        synth = synthTemplate("commercial", {
            mutate: enableMiris("perView"),
            mutateKey: "miris-viewer-key-mint-perView",
        });
    });

    describe("mint route and Lambda", () => {
        test("the mint route is registered for POST only, beside the status route", () => {
            const paths = restApiPaths(synth);
            expect(paths[STATUS_ROUTE]).toBeDefined();
            expect(paths[MINT_ROUTE]).toBeDefined();
            const methods = Object.keys(paths[MINT_ROUTE]).filter((m) => m !== "options");
            expect(methods).toEqual(["post"]);
        });

        test("exactly one mint Lambda is deployed with the Integration Key, base URL and TTL", () => {
            const fns = functionsWithHandler(synth, MINT_HANDLER);
            expect(fns).toHaveLength(1);
            const env = fns[0].properties.Environment.Variables;
            expect(env.MIRIS_API_KEY_SECRET_ARN).toBe(SECRET_ARN);
            expect(env.MIRIS_API_BASE_URL).toBe("https://app.miris.com");
            expect(env.MIRIS_VIEWER_KEY_TTL_MINUTES).toBe("7");
            expect(env).not.toHaveProperty("MIRIS_VIEWER_KEY");
            // Table names resolve through SSM, not per-table environment variables.
            expect(env.VAMS_RESOURCE_PARAM_PREFIX).toBeDefined();
            expect(Object.keys(env).filter((k) => k.endsWith("_TABLE_NAME"))).toEqual([]);
        });

        test("reads exactly the configured secret and nothing else in Secrets Manager", () => {
            expectExactSecretGrant(roleStatements(synth, MINT_HANDLER));
        });

        test("can only put rows into the viewer key table", () => {
            const statements = roleStatements(synth, MINT_HANDLER);
            const keyTableStatements = statements.filter((s) =>
                JSON.stringify(s.Resource).includes("MirisViewerKeyStorageTable")
            );
            expect(keyTableStatements.length).toBeGreaterThan(0);
            expect(keyTableStatements.flatMap(actionsOf)).toEqual(["dynamodb:PutItem"]);
        });

        test("reads, and cannot write, the asset and file metadata tables", () => {
            const statements = roleStatements(synth, MINT_HANDLER);
            const reads = statements.filter((s) => actionsOf(s).includes("dynamodb:GetItem"));
            const readResources = JSON.stringify(reads.map((s) => s.Resource));
            expect(readResources).toMatch(/AssetStorageTable/);
            expect(readResources).toMatch(/AssetFileMetadataStorageTableV2/);
            expect(readResources).not.toMatch(/MirisViewerKeyStorageTable/);

            const writes = statements.filter((s) =>
                actionsOf(s).some((a) =>
                    /^dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem|\*)$/.test(a)
                )
            );
            expect(JSON.stringify(writes.map((s) => s.Resource))).not.toMatch(
                /AssetStorageTable|AssetFileMetadataStorageTable/
            );
        });
    });

    describe("status Lambda", () => {
        test("carries no viewer key and has the Integration Key secret ARN", () => {
            const fns = functionsWithHandler(synth, STATUS_HANDLER);
            expect(fns).toHaveLength(1);
            const env = fns[0].properties.Environment.Variables;
            expect(env.MIRIS_VIEWER_KEY_MODE).toBe("perView");
            expect(env.MIRIS_VIEWER_KEY).toBe("");
            expect(env.MIRIS_API_KEY_SECRET_ARN).toBe(SECRET_ARN);
        });

        test("reads exactly the configured secret", () => {
            expectExactSecretGrant(roleStatements(synth, STATUS_HANDLER));
        });

        test("still writes no DynamoDB data", () => {
            const writes = roleStatements(synth, STATUS_HANDLER)
                .flatMap(actionsOf)
                .filter((a) =>
                    /^dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem|\*)$/.test(a)
                );
            expect(writes).toEqual([]);
        });
    });

    test("no Lambda in any stack carries a non-empty MIRIS_VIEWER_KEY", () => {
        const withKey = synth
            .ofType("AWS::Lambda::Function")
            .filter((r) => {
                const value = r.properties.Environment?.Variables?.MIRIS_VIEWER_KEY;
                return value !== undefined && value !== "";
            })
            .map((r) => r.logicalId);
        expect(withKey).toEqual([]);
        // Control: the variable is present (as "") on the status Lambda, so the scan saw it.
        expect(
            functionsWithHandler(synth, STATUS_HANDLER)[0].properties.Environment.Variables
        ).toHaveProperty("MIRIS_VIEWER_KEY", "");
    });
});
