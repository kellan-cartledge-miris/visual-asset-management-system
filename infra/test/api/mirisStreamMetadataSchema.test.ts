/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The GLOBAL "Miris stream" file metadata schema is seeded with `app.miris.enabled`.
 *
 * The schema is written by an AwsCustomResource putItem into the metadata schema table, alongside the
 * `app.metadataSchema.autoLoadDefault*` schemas. The item is built from
 * `dynamodb-metadataschema-miris-stream.json`, the same file the backend test
 * `backend/tests/models/test_metadataSchema_miris_stream_seed.py` validates against the Pydantic
 * models, so this suite pins the template to that file and the backend suite pins the file to the
 * models.
 *
 * AwsCustomResource providers are a per-stack singleton: every custom resource in the stack runs on
 * the role of whichever was created first. The Miris schema therefore shares the default schemas'
 * provider role, and that role exists whenever either is enabled.
 */

import { Resource, SynthResult, synthTemplate } from "../support/templateSynth";
import mirisStreamSchema from "../../lib/nestedStacks/apiLambda/constructs/dynamodb-metadataschema-miris-stream.json";

const MIRIS_SCHEMA_ID = "miris-stream-file-schema";
const DEFAULT_SCHEMA_IDS = [
    "default-assetlinks-schema",
    "default-database-schema",
    "default-asset-schema",
    "default-file-schema-3dmodel",
];
const PROVIDER_ROLE_PREFIX = "MetadataSchemaDefaultCustomResourceRole";
const PROVIDER_FUNCTION_PREFIX = "AWS679f53fac002430cb0da5b7982bd2287";

function enableMiris(c: any) {
    c.app.webUi.allowUnsafeEvalFeatures = true;
    c.app.miris.enabled = true;
    c.app.miris.viewerKey = "test-placeholder-viewer-key-000000";
}

function enableMirisWithoutDefaultSchemas(c: any) {
    enableMiris(c);
    c.app.metadataSchema.autoLoadDefaultAssetLinksSchema = false;
    c.app.metadataSchema.autoLoadDefaultDatabaseSchema = false;
    c.app.metadataSchema.autoLoadDefaultAssetSchema = false;
    c.app.metadataSchema.autoLoadDefaultAssetFileSchema = false;
    c.app.useKmsCmkEncryption.enabled = true;
}

/** The putItem call a metadata-schema custom resource makes on create, with tokens flattened. */
function createCall(resource: Resource): any {
    return JSON.parse(SynthResult.flatten(resource.properties.Create));
}

/** Every metadata-schema seeding custom resource, keyed by the schema id it writes. */
function schemaSeeds(synth: SynthResult): Map<string, Resource> {
    const seeds = new Map<string, Resource>();
    for (const resource of synth.ofType("Custom::AWS")) {
        const call = createCall(resource);
        const schemaId = call.parameters?.Item?.metadataSchemaId?.S;
        if (call.service === "DynamoDB" && call.action === "putItem" && schemaId) {
            expect(seeds.has(schemaId)).toBe(false);
            seeds.set(schemaId, resource);
        }
    }
    return seeds;
}

function providerRoles(synth: SynthResult, stack: string): Resource[] {
    return synth.where(
        "AWS::IAM::Role",
        (r) => r.stack === stack && r.logicalId.startsWith(PROVIDER_ROLE_PREFIX)
    );
}

function providerFunctions(synth: SynthResult, stack: string): Resource[] {
    return synth.where(
        "AWS::Lambda::Function",
        (r) => r.stack === stack && r.logicalId.startsWith(PROVIDER_FUNCTION_PREFIX)
    );
}

describe("Miris disabled (stock commercial template)", () => {
    let synth: SynthResult;

    beforeAll(() => {
        synth = synthTemplate("commercial");
    });

    test("[control] the default schemas are seeded", () => {
        expect([...schemaSeeds(synth).keys()].sort()).toEqual([...DEFAULT_SCHEMA_IDS].sort());
    });

    test("the Miris stream schema is not seeded", () => {
        expect(schemaSeeds(synth).has(MIRIS_SCHEMA_ID)).toBe(false);
        expect(synth.grep(MIRIS_SCHEMA_ID)).toEqual([]);
    });
});

describe.each([
    ["Miris enabled with the default schemas", "miris-schema-with-defaults", enableMiris, true],
    [
        "Miris enabled without the default schemas, with a KMS CMK",
        "miris-schema-without-defaults-kms",
        enableMirisWithoutDefaultSchemas,
        false,
    ],
])("%s", (_label, mutateKey, mutate, defaultsSeeded) => {
    let synth: SynthResult;
    let seed: Resource;

    beforeAll(() => {
        synth = synthTemplate("commercial", { mutate, mutateKey });
        seed = schemaSeeds(synth).get(MIRIS_SCHEMA_ID) as Resource;
    });

    test("exactly one custom resource seeds the Miris stream schema", () => {
        expect(seed).toBeDefined();
        expect(synth.grep(MIRIS_SCHEMA_ID).map((r) => r.logicalId)).toEqual([seed.logicalId]);
    });

    test("the default schemas are seeded exactly as their own flags say", () => {
        const others = [...schemaSeeds(synth).keys()].filter((id) => id !== MIRIS_SCHEMA_ID);
        expect(others.sort()).toEqual(defaultsSeeded ? [...DEFAULT_SCHEMA_IDS].sort() : []);
    });

    test("create and update write the same GLOBAL fileMetadata item", () => {
        const create = createCall(seed);
        const update = JSON.parse(SynthResult.flatten(seed.properties.Update));
        expect(update).toEqual(create);
        expect(create.physicalResourceId.id).toMatch(/_mirisstream_initialization$/);
        expect(seed.properties.Delete).toBeUndefined();

        const item = create.parameters.Item;
        expect(create.parameters.TableName).toMatch(/MetadataSchemaStorageTableV2/);
        expect(item.metadataSchemaId).toEqual({ S: MIRIS_SCHEMA_ID });
        expect(item["databaseId:metadataEntityType"]).toEqual({ S: "GLOBAL:fileMetadata" });
        expect(item.databaseId).toEqual({ S: "GLOBAL" });
        expect(item.metadataSchemaEntityType).toEqual({ S: "fileMetadata" });
        expect(item.schemaName).toEqual({ S: "Miris stream" });
        expect(item.fileKeyTypeRestriction).toEqual({ S: ".usd,.usda,.usdc,.usdz" });
        expect(item.enabled).toEqual({ BOOL: true });
        expect(item.createdBy).toEqual({ S: "SYSTEM_USER" });
        expect(item.modifiedBy).toEqual({ S: "SYSTEM_USER" });
        expect(item.dateCreated.S).toEqual(item.dateModified.S);
    });

    test("the four optional fields carry the contract's value types", () => {
        const stored = JSON.parse(createCall(seed).parameters.Item.fields.S);
        expect(stored).toEqual({ fields: mirisStreamSchema.fields });
        expect(
            stored.fields.map((f: any) => [
                f.metadataFieldKeyName,
                f.metadataFieldValueType,
                f.required,
            ])
        ).toEqual([
            ["miris_asset_uuid", "string", false],
            ["miris_source_version_id", "string", false],
            ["miris_uploaded_at", "date", false],
            ["miris_display_name", "string", false],
        ]);
    });

    test("the provider runs on one role that can only put items into the schema table", () => {
        const roles = providerRoles(synth, seed.stack);
        expect(roles).toHaveLength(1);
        const roleId = roles[0].logicalId;

        const functions = providerFunctions(synth, seed.stack);
        expect(functions).toHaveLength(1);
        expect(functions[0].properties.Role["Fn::GetAtt"][0]).toBe(roleId);

        const tableStatements = (roles[0].properties.Policies as any[]).flatMap(
            (p) => p.PolicyDocument.Statement
        );
        expect(tableStatements).toHaveLength(1);
        expect(tableStatements[0].Action).toBe("dynamodb:PutItem");
        expect(SynthResult.flatten(tableStatements[0].Resource)).toMatch(
            /MetadataSchemaStorageTableV2/
        );
    });

    test("the provider role gets key-scoped KMS access only with a KMS CMK", () => {
        const [role] = providerRoles(synth, seed.stack);
        const kmsPolicies = synth.where(
            "AWS::IAM::Policy",
            (p) =>
                p.stack === seed.stack &&
                (p.properties.Roles ?? []).some((r: any) => r?.Ref === role.logicalId)
        );
        if (defaultsSeeded) {
            expect(kmsPolicies).toEqual([]);
            return;
        }
        expect(kmsPolicies).toHaveLength(1);
        const statements = kmsPolicies[0].properties.PolicyDocument.Statement as any[];
        expect(statements).toHaveLength(1);
        expect(statements[0].Action).toContain("kms:Decrypt");
        expect(statements[0].Resource).not.toBe("*");
    });
});
