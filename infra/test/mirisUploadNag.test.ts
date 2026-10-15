/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Miris upload nested stack synthesizes with no unsuppressed AwsSolutions finding.
 *
 * `templateSynth` runs no Nag rule and `mirisUploadSynth.test.ts` leaves Nag off, so neither catches
 * a suppression that matches nothing: the finding surfaces only on a real `cdk synth`, as a
 * "Synthesis finished with errors" failure. This applies `AwsSolutionsChecks` the way bin/infra.ts
 * does and reads the error annotations the aspect stamps onto the nested stack's constructs.
 *
 * One synth per file: cdk-nag reports reliably only on the first synth in a jest process.
 */

import * as cdk from "aws-cdk-lib";
import { Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { MIRIS_TEST_APP_CONTEXT, newMirisCoreStack } from "./support/mirisCoreStack";
import { newTestApp } from "./support/testApp";

test("the Miris upload nested stack has no unsuppressed AwsSolutions error", () => {
    const app = newTestApp({ context: MIRIS_TEST_APP_CONTEXT });
    // `logIgnores` records each applied suppression as an info annotation, for the control below.
    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true, logIgnores: true }));
    const stack = newMirisCoreStack(app, "Test stack for VAMS Miris upload Nag checks");

    app.synth();

    const mirisUploadBuilder = stack.node
        .findChild("PipelineBuilder")
        .node.findChild("MirisUploadBuilderNestedStack") as cdk.NestedStack;

    const nodes = mirisUploadBuilder.node.findAll();
    // Control: the nested stack was built and walked, or "no errors" is vacuous.
    expect(nodes.some((node) => node.node.path.includes("MirisUploadInnerStateMachine"))).toBe(
        true
    );

    // Control: the aspect ran. A Nag pack that never visited the stack would also report no errors,
    // so require at least one suppression it recorded as applied.
    const all = nodes.flatMap((node) =>
        node.node.metadata.map((entry) => ({ path: node.node.path, entry }))
    );
    expect(
        all.some(
            ({ entry }) =>
                entry.type === "aws:cdk:info" && String(entry.data).includes("AwsSolutions-")
        )
    ).toBe(true);

    const errors = all
        .filter(
            ({ entry }) =>
                entry.type === "aws:cdk:error" && String(entry.data).includes("AwsSolutions-")
        )
        .map(({ path, entry }) => `${path}: ${String(entry.data).split("\n")[0]}`);
    expect(errors).toEqual([]);
});
