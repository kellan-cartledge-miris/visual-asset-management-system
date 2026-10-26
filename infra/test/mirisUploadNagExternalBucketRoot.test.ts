/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Miris upload nested stack has no unsuppressed AwsSolutions finding when an external asset
 * bucket is registered at its root (no `baseAssetsPrefix`), so its object grants are
 * `arn:aws:s3:::bucket/*` rather than a prefixed key. One synth per file, because cdk-nag reports
 * reliably only on the first synth in a jest process.
 */

import { mirisUploadNagErrors } from "./support/mirisUploadNag";

test("the Miris upload nested stack has no unsuppressed AwsSolutions error with an external bucket at its root", () => {
    const errors = mirisUploadNagErrors(
        "Test stack for VAMS Miris upload Nag checks with an external asset bucket at its root",
        (c) => {
            c.app.assetBuckets.externalAssetBuckets = [
                {
                    bucketArn: "arn:aws:s3:::ext-vams-assets",
                    baseAssetsPrefix: "/",
                    defaultSyncDatabaseId: "ext-db",
                } as any,
            ];
        }
    );
    expect(errors).toEqual([]);
});
