/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Miris upload nested stack has no unsuppressed AwsSolutions finding with the customer managed
 * KMS key enabled, which adds the key statements to every role that reads or writes encrypted
 * storage. One synth per file, because cdk-nag reports reliably only on the first synth in a jest
 * process.
 */

import { mirisUploadNagErrors } from "./support/mirisUploadNag";

test("the Miris upload nested stack has no unsuppressed AwsSolutions error with a customer managed key", () => {
    const errors = mirisUploadNagErrors(
        "Test stack for VAMS Miris upload Nag checks with a customer managed key",
        (c) => {
            c.app.useKmsCmkEncryption.enabled = true;
        }
    );
    expect(errors).toEqual([]);
});
