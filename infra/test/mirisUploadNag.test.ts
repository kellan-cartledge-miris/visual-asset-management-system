/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Miris upload nested stack synthesizes with no unsuppressed AwsSolutions finding.
 *
 * The external-asset-bucket variant is `mirisUploadNagExternalBucket.test.ts`: one synth per file,
 * because cdk-nag reports reliably only on the first synth in a jest process.
 */

import { mirisUploadNagErrors } from "./support/mirisUploadNag";

test("the Miris upload nested stack has no unsuppressed AwsSolutions error", () => {
    expect(mirisUploadNagErrors("Test stack for VAMS Miris upload Nag checks")).toEqual([]);
});
