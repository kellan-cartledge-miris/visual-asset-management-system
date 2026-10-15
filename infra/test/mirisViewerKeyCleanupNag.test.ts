/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In Miris "perView" mode, the stacks holding the viewer key table, its cleanup Lambda and the viewer
 * key mint Lambda synthesize with no unsuppressed AwsSolutions finding.
 *
 * `templateSynth` leaves Nag off, so a suppression that matches nothing, or a finding with no
 * suppression, surfaces only on a real `cdk synth`. This applies `AwsSolutionsChecks` the way
 * bin/infra.ts does and reads the error annotations the aspect stamps onto the per-view constructs:
 * the table in the storage nested stack, and the cleanup Lambda, its mapping and its dead-letter
 * queue, the mint Lambda and the status Lambda in the API nested stack.
 *
 * The assertion is scoped to those constructs. In a jest synth the shared grant suppressions do not
 * reach the OverflowPolicy resources CDK splits off large roles at synthesis, so other functions in
 * the same stacks report findings that are identical in static mode and unrelated to this one.
 *
 * The API nested stack carries a stack-wide AwsSolutions-IAM5 suppression, so for the API constructs
 * this check enforces the other rules; the mint and status Lambdas' IAM scope is asserted directly in
 * `api/mirisViewerKeyMint.test.ts`.
 *
 * One synth per file: cdk-nag reports reliably only on the first synth in a jest process.
 */

import * as cdk from "aws-cdk-lib";
import { Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { MIRIS_TEST_APP_CONTEXT, newMirisCoreStack } from "./support/mirisCoreStack";
import { newTestApp } from "./support/testApp";

test("the per-view viewer key resources have no unsuppressed AwsSolutions error", () => {
    const app = newTestApp({ context: MIRIS_TEST_APP_CONTEXT });
    // `logIgnores` records each applied suppression as an info annotation, for the controls below.
    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true, logIgnores: true }));
    const stack = newMirisCoreStack(
        app,
        "Test stack for VAMS Miris per-view key Nag checks",
        (c) => {
            c.app.miris.viewerKeyMode = "perView";
            c.app.miris.viewerKey = "UNDEFINED";
            // Isolates the per-view resources; the upload pipeline has its own Nag test.
            c.app.miris.upload.enabled = false;
        }
    );

    app.synth();

    const nestedStacks = ["StorageResourcesBuilder", "ApiBuilder"].map(
        (id) => stack.node.findChild(id) as cdk.NestedStack
    );
    const nodes = nestedStacks.flatMap((nested) => nested.node.findAll());
    const paths = nodes.map((node) => node.node.path);

    const perViewConstructs = [
        "StorageResourcesBuilder/MirisViewerKeyStorageTable",
        "ApiBuilder/MirisViewerKeyCleanupFunction",
        "ApiBuilder/MirisViewerKeyCleanupStream",
        "ApiBuilder/MirisViewerKeyCleanupDLQ",
        "ApiBuilder/MirisMintViewerKeyFunction",
        "ApiBuilder/MirisGetAssetStatusFunction",
    ].map((id) => `${stack.node.path}/${id}`);
    const isPerView = (path: string) =>
        perViewConstructs.some((root) => path === root || path.startsWith(`${root}/`));

    // Control: every per-view construct was built and walked, or "no errors" is vacuous.
    for (const root of perViewConstructs) {
        expect(paths).toContain(root);
    }

    const all = nodes
        .filter((node) => isPerView(node.node.path))
        .flatMap((node) => node.node.metadata.map((entry) => ({ path: node.node.path, entry })));

    // Control: the aspect visited the cleanup Lambda's role and applied its stream-list and DLQ
    // suppressions there. A Nag pack that never reached it would also report no errors.
    const cleanupInfos = all.filter(
        ({ entry }) => entry.type === "aws:cdk:info" && String(entry.data).includes("AwsSolutions-")
    );
    expect(cleanupInfos.some(({ entry }) => String(entry.data).includes("ListStreams"))).toBe(true);
    expect(cleanupInfos.some(({ entry }) => String(entry.data).includes("AwsSolutions-SQS3"))).toBe(
        true
    );
    // Control: the aspect also reached the mint Lambda's role (its standard Lambda suppressions).
    const mintRoot = `${stack.node.path}/ApiBuilder/MirisMintViewerKeyFunction`;
    expect(
        cleanupInfos.some(({ path }) => path === mintRoot || path.startsWith(`${mintRoot}/`))
    ).toBe(true);

    const errors = all
        .filter(
            ({ entry }) =>
                entry.type === "aws:cdk:error" && String(entry.data).includes("AwsSolutions-")
        )
        .map(({ path, entry }) => `${path}: ${String(entry.data).split("\n")[0]}`);
    expect(errors).toEqual([]);
});
