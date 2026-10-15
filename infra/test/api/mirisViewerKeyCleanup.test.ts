/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-view Miris viewer keys are recorded in MirisViewerKeyStorageTable, whose TTL deletions stream to
 * a cleanup Lambda that deletes each expired key from the Miris workspace.
 *
 * In "perView" mode the table exists with a `ttl` TTL attribute, a KEYS_ONLY stream, the shared
 * table defaults (encryption, point-in-time recovery, RETAIN) and a resource-name SSM parameter. Its
 * stream is mapped to the cleanup Lambda with a filter for TTL deletions only, per-record failure
 * reporting, and an on-failure dead-letter queue. The cleanup Lambda reads exactly the configured
 * Integration Key secret. In "static" mode none of these are deployed.
 */

import { Resource, SynthResult, synthTemplate } from "../support/templateSynth";

const CLEANUP_HANDLER = "handlers.miris.viewerKeyCleanup.lambda_handler";
const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-miris-api-key-AbCdEf";
const PARAM_SUFFIX = "/resourceNames/dynamoTables/mirisViewerKeyStorage";

function enableMiris(viewerKeyMode: "static" | "perView") {
    return (c: any) => {
        c.app.webUi.allowUnsafeEvalFeatures = true;
        c.app.miris.enabled = true;
        c.app.miris.viewerKeyMode = viewerKeyMode;
        c.app.miris.viewerKey =
            viewerKeyMode === "static" ? "test-placeholder-viewer-key-000000" : "UNDEFINED";
        c.app.miris.apiKeySecretArn = SECRET_ARN;
    };
}

function viewerKeyTables(synth: SynthResult): Resource[] {
    return synth.where("AWS::DynamoDB::Table", (r) =>
        (r.properties.KeySchema ?? []).some((k: any) => k.AttributeName === "mirisViewerKeyId")
    );
}

function cleanupFunctions(synth: SynthResult): Resource[] {
    return synth.where("AWS::Lambda::Function", (r) => r.properties.Handler === CLEANUP_HANDLER);
}

function viewerKeyParams(synth: SynthResult): Resource[] {
    return synth.where("AWS::SSM::Parameter", (r) =>
        SynthResult.flatten(r.properties.Name).endsWith(PARAM_SUFFIX)
    );
}

function cleanupMappings(synth: SynthResult): Resource[] {
    const fnIds = cleanupFunctions(synth).map((f) => f.logicalId);
    return synth.where("AWS::Lambda::EventSourceMapping", (r) =>
        fnIds.includes(r.properties.FunctionName?.Ref)
    );
}

/** Every IAM statement attached to the cleanup Lambda's execution role. */
function cleanupRoleStatements(synth: SynthResult): any[] {
    const [fn] = cleanupFunctions(synth);
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

describe("Miris enabled, viewerKeyMode static", () => {
    let synth: SynthResult;

    beforeAll(() => {
        synth = synthTemplate("commercial", {
            mutate: enableMiris("static"),
            mutateKey: "miris-viewer-key-cleanup-static",
        });
    });

    test("[control] Miris is deployed: the status Lambda exists", () => {
        expect(
            synth.where(
                "AWS::Lambda::Function",
                (r) => r.properties.Handler === "handlers.miris.getAssetStatus.lambda_handler"
            )
        ).toHaveLength(1);
    });

    test("no viewer key table, resource-name parameter, cleanup Lambda or mapping is deployed", () => {
        expect(viewerKeyTables(synth)).toHaveLength(0);
        expect(viewerKeyParams(synth)).toHaveLength(0);
        expect(cleanupFunctions(synth)).toHaveLength(0);
        expect(synth.grep("MirisViewerKeyCleanup")).toEqual([]);
    });
});

describe("Miris enabled, viewerKeyMode perView", () => {
    let synth: SynthResult;

    beforeAll(() => {
        synth = synthTemplate("commercial", {
            mutate: enableMiris("perView"),
            mutateKey: "miris-viewer-key-cleanup-perView",
        });
    });

    describe("MirisViewerKeyStorageTable", () => {
        test("exists once, keyed by mirisViewerKeyId", () => {
            const tables = viewerKeyTables(synth);
            expect(tables).toHaveLength(1);
            expect(tables[0].logicalId).toMatch(/^MirisViewerKeyStorageTable/);
            expect(tables[0].properties.KeySchema).toEqual([
                { AttributeName: "mirisViewerKeyId", KeyType: "HASH" },
            ]);
        });

        test("expires rows on the ttl attribute and streams their keys only", () => {
            const [table] = viewerKeyTables(synth);
            expect(table.properties.TimeToLiveSpecification).toEqual({
                AttributeName: "ttl",
                Enabled: true,
            });
            expect(table.properties.StreamSpecification).toEqual({ StreamViewType: "KEYS_ONLY" });
        });

        test("uses the shared table defaults: encryption, PITR, RETAIN, auto-named", () => {
            const [table] = viewerKeyTables(synth);
            // Rule 8: encryption matches the other VAMS tables in the same stack.
            const [apiKeyTable] = synth.where(
                "AWS::DynamoDB::Table",
                (r) => r.stack === table.stack && r.logicalId.startsWith("ApiKeyStorageTable")
            );
            expect(apiKeyTable).toBeDefined();
            expect(table.properties.SSESpecification).toEqual(
                apiKeyTable.properties.SSESpecification
            );
            expect(table.properties.PointInTimeRecoverySpecification).toEqual({
                PointInTimeRecoveryEnabled: true,
            });
            expect(table.raw.DeletionPolicy).toBe("Retain");
            expect(table.properties.TableName).toBeUndefined();
        });

        test("publishes its name as a resource-name SSM parameter", () => {
            expect(viewerKeyParams(synth)).toHaveLength(1);
        });
    });

    describe("cleanup Lambda", () => {
        test("exists once with the Integration Key secret ARN and the Miris API base URL", () => {
            const fns = cleanupFunctions(synth);
            expect(fns).toHaveLength(1);
            const env = fns[0].properties.Environment.Variables;
            expect(env.MIRIS_API_KEY_SECRET_ARN).toBe(SECRET_ARN);
            expect(env.MIRIS_API_BASE_URL).toBe("https://app.miris.com");
            expect(env).not.toHaveProperty("MIRIS_VIEWER_KEY");
        });

        test("reads exactly the configured secret and nothing else in Secrets Manager", () => {
            const statements = cleanupRoleStatements(synth);
            const secretStatements = statements.filter((s) =>
                actionsOf(s).some((a) => a.startsWith("secretsmanager:"))
            );
            expect(secretStatements).toHaveLength(1);
            expect(actionsOf(secretStatements[0])).toEqual(["secretsmanager:GetSecretValue"]);
            expect(secretStatements[0].Resource).toBe(SECRET_ARN);
            expect(secretStatements[0].Effect).toBe("Allow");
        });

        test("reads the table's stream and writes no DynamoDB data", () => {
            const statements = cleanupRoleStatements(synth);
            const actions = statements.flatMap(actionsOf);
            expect(actions).toEqual(expect.arrayContaining(["dynamodb:GetRecords"]));
            const streamStatement = statements.find((s) =>
                actionsOf(s).includes("dynamodb:GetRecords")
            );
            expect(JSON.stringify(streamStatement.Resource)).toContain(
                "MirisViewerKeyStorageTable"
            );
            const writes = actions.filter((a) =>
                /^dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem|\*)$/.test(a)
            );
            expect(writes).toEqual([]);
        });
    });

    describe("event source mapping", () => {
        test("maps the table's stream to the cleanup Lambda once", () => {
            const mappings = cleanupMappings(synth);
            expect(mappings).toHaveLength(1);
            expect(JSON.stringify(mappings[0].properties.EventSourceArn)).toContain(
                "MirisViewerKeyStorageTable"
            );
        });

        test("filters to TTL deletions only", () => {
            const [mapping] = cleanupMappings(synth);
            const filters = mapping.properties.FilterCriteria.Filters;
            expect(filters).toHaveLength(1);
            expect(JSON.parse(filters[0].Pattern)).toEqual({
                eventName: ["REMOVE"],
                userIdentity: {
                    type: ["Service"],
                    principalId: ["dynamodb.amazonaws.com"],
                },
            });
        });

        test("reports per-record failures, bisects, bounds retries, and has an on-failure queue", () => {
            const [mapping] = cleanupMappings(synth);
            expect(mapping.properties.FunctionResponseTypes).toEqual(["ReportBatchItemFailures"]);
            expect(mapping.properties.BisectBatchOnFunctionError).toBe(true);
            expect(mapping.properties.MaximumRetryAttempts).toBe(10);

            const destination = mapping.properties.DestinationConfig.OnFailure.Destination;
            const queueLogicalId = destination["Fn::GetAtt"][0];
            const [queue] = synth.where(
                "AWS::SQS::Queue",
                (q) => q.stack === mapping.stack && q.logicalId === queueLogicalId
            );
            expect(queue).toBeDefined();
            expect(queueLogicalId).toMatch(/^MirisViewerKeyCleanupDLQ/);
            // Encrypted with the deployment CMK when one is configured, else SQS-managed.
            expect(
                queue.properties.KmsMasterKeyId !== undefined ||
                    queue.properties.SqsManagedSseEnabled === true
            ).toBe(true);
        });
    });
});
