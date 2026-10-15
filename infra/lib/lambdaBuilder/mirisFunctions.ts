/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as lambda from "aws-cdk-lib/aws-lambda";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "path";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import * as Config from "../../config/config";
import { LAMBDA_PYTHON_RUNTIME } from "../../config/config";
import { storageResources } from "../nestedStacks/storage/storageBuilder-nestedStack";
import {
    globalLambdaEnvironmentsAndPermissions,
    kmsKeyLambdaPermissionAddToResourcePolicy,
    setupSecurityAndLoggingEnvironmentAndPermissions,
    suppressCdkNagDynamoStreamListWildcard,
    suppressCdkNagLambda,
    suppressCdkNagErrorsByGrantReadWrite,
} from "../helper/security";

/** Read access to exactly the configured Miris Integration Key secret. */
function mirisIntegrationKeyReadStatement(config: Config.Config): iam.PolicyStatement {
    return new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [config.app.miris.apiKeySecretArn],
    });
}

export function buildGetMirisAssetStatusFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    storageResources: storageResources,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
): lambda.Function {
    const name = "getAssetStatus";
    const perView = config.app.miris.viewerKeyMode === "perView";
    const fun = new lambda.Function(scope, "MirisGetAssetStatusFunction", {
        code: lambda.Code.fromAsset(path.join(__dirname, "../../../backend/backend")),
        handler: `handlers.miris.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.seconds(30),
        memorySize: Config.LAMBDA_MEMORY_SIZE,
        vpc:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? vpc
                : undefined,
        vpcSubnets:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? { subnets: subnets }
                : undefined,
        environment: {
            MIRIS_API_BASE_URL: config.app.miris.mirisApiBaseUrl,
            MIRIS_VIEWER_KEY_MODE: config.app.miris.viewerKeyMode,
            // Static mode: the status probe authenticates with the deployment-wide VIEWER
            // key, the same credential the frontend streams with, so it can only ever see
            // the assets the viewer can play. Per-view mode has no deployment-wide viewer
            // key, so the probe reads the asset with the Integration Key instead.
            MIRIS_VIEWER_KEY: perView ? "" : config.app.miris.viewerKey,
            ...(perView ? { MIRIS_API_KEY_SECRET_ARN: config.app.miris.apiKeySecretArn } : {}),
        },
    });

    // Read-only: the asset record for Tier-2 authorization, and the Miris stream keys
    // stored as file metadata on the viewed file.
    storageResources.dynamo.assetStorageTable.grantReadData(fun);
    storageResources.dynamo.assetFileMetadataStorageTable.grantReadData(fun);

    // Per-view mode: the Miris Integration Key, which authorizes the asset state read.
    if (perView) {
        fun.addToRolePolicy(mirisIntegrationKeyReadStatement(config));
    }

    kmsKeyLambdaPermissionAddToResourcePolicy(fun, storageResources.encryption.kmsKey);
    setupSecurityAndLoggingEnvironmentAndPermissions(fun, storageResources);
    globalLambdaEnvironmentsAndPermissions(fun, config);
    suppressCdkNagLambda(fun);
    suppressCdkNagErrorsByGrantReadWrite(scope);

    return fun;
}

/**
 * Deletes a per-view Miris viewer key from the Miris workspace when DynamoDB TTL removes its row
 * from MirisViewerKeyStorageTable. The caller attaches the table's stream with an event source
 * mapping.
 */
export function buildMirisViewerKeyCleanupFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    storageResources: storageResources,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
): lambda.Function {
    const viewerKeyTable = storageResources.dynamo.mirisViewerKeyStorageTable;
    if (!viewerKeyTable) {
        throw new Error(
            "buildMirisViewerKeyCleanupFunction requires MirisViewerKeyStorageTable, which exists " +
                'only when app.miris.viewerKeyMode is "perView".'
        );
    }

    const name = "viewerKeyCleanup";
    const fun = new lambda.Function(scope, "MirisViewerKeyCleanupFunction", {
        code: lambda.Code.fromAsset(path.join(__dirname, "../../../backend/backend")),
        handler: `handlers.miris.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(5),
        memorySize: Config.LAMBDA_MEMORY_SIZE,
        vpc:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? vpc
                : undefined,
        vpcSubnets:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? { subnets: subnets }
                : undefined,
        environment: {
            MIRIS_API_KEY_SECRET_ARN: config.app.miris.apiKeySecretArn,
            MIRIS_API_BASE_URL: config.app.miris.mirisApiBaseUrl,
        },
    });

    // The Miris Integration Key, which authorizes the viewer key deletes.
    fun.addToRolePolicy(mirisIntegrationKeyReadStatement(config));

    // The table's stream, which carries the key IDs of TTL-deleted rows.
    viewerKeyTable.grantStreamRead(fun);

    kmsKeyLambdaPermissionAddToResourcePolicy(fun, storageResources.encryption.kmsKey);
    setupSecurityAndLoggingEnvironmentAndPermissions(fun, storageResources);
    globalLambdaEnvironmentsAndPermissions(fun, config);
    suppressCdkNagDynamoStreamListWildcard(fun);
    suppressCdkNagLambda(fun);

    return fun;
}

/**
 * Mints a per-view Miris viewer key for one asset file and records its key ID in
 * MirisViewerKeyStorageTable (POST /database/{databaseId}/assets/{assetId}/miris/viewer-key).
 */
export function buildMintMirisViewerKeyFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    storageResources: storageResources,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
): lambda.Function {
    const viewerKeyTable = storageResources.dynamo.mirisViewerKeyStorageTable;
    if (!viewerKeyTable) {
        throw new Error(
            "buildMintMirisViewerKeyFunction requires MirisViewerKeyStorageTable, which exists " +
                'only when app.miris.viewerKeyMode is "perView".'
        );
    }

    const name = "mintViewerKey";
    const fun = new lambda.Function(scope, "MirisMintViewerKeyFunction", {
        code: lambda.Code.fromAsset(path.join(__dirname, "../../../backend/backend")),
        handler: `handlers.miris.${name}.lambda_handler`,
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.seconds(30),
        memorySize: Config.LAMBDA_MEMORY_SIZE,
        vpc:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? vpc
                : undefined,
        vpcSubnets:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? { subnets: subnets }
                : undefined,
        environment: {
            MIRIS_API_KEY_SECRET_ARN: config.app.miris.apiKeySecretArn,
            MIRIS_API_BASE_URL: config.app.miris.mirisApiBaseUrl,
            MIRIS_VIEWER_KEY_TTL_MINUTES: String(config.app.miris.perViewKey.ttlMinutes),
        },
    });

    // The Miris Integration Key, which authorizes the viewer key creates (and the delete of a
    // key whose table row could not be written).
    fun.addToRolePolicy(mirisIntegrationKeyReadStatement(config));

    // Read-only: the asset record for Tier-2 authorization, and the Miris stream keys
    // stored as file metadata on the file.
    storageResources.dynamo.assetStorageTable.grantReadData(fun);
    storageResources.dynamo.assetFileMetadataStorageTable.grantReadData(fun);

    // Put-only: one row per minted key. The table has no index.
    viewerKeyTable.grant(fun, "dynamodb:PutItem");

    kmsKeyLambdaPermissionAddToResourcePolicy(fun, storageResources.encryption.kmsKey);
    setupSecurityAndLoggingEnvironmentAndPermissions(fun, storageResources);
    globalLambdaEnvironmentsAndPermissions(fun, config);
    suppressCdkNagLambda(fun);
    suppressCdkNagErrorsByGrantReadWrite(scope);

    return fun;
}
