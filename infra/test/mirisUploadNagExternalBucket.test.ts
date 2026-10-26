/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Miris upload nested stack has no unsuppressed AwsSolutions finding when an external asset
 * bucket is configured.
 *
 * An imported bucket's ARN comes from config as a literal (`arn:aws:s3:::bucket`), not as a
 * `<AWS::Partition>` token or a GetAtt, so a suppression written only against the created bucket's
 * shapes leaves every grant on the external bucket as a synth error. One synth per file, because
 * cdk-nag reports reliably only on the first synth in a jest process.
 */

import { mirisUploadNagErrors } from "./support/mirisUploadNag";

test("the Miris upload nested stack has no unsuppressed AwsSolutions error with an external asset bucket", () => {
    const errors = mirisUploadNagErrors(
        "Test stack for VAMS Miris upload Nag checks with an external asset bucket",
        (c) => {
            c.app.assetBuckets.externalAssetBuckets = [
                {
                    bucketArn: "arn:aws:s3:::ext-vams-assets",
                    baseAssetsPrefix: "vams/data/",
                    defaultSyncDatabaseId: "ext-db",
                } as any,
            ];
        }
    );
    expect(errors).toEqual([]);
});
