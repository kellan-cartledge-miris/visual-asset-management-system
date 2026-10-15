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

export function buildGetMirisAssetStatusFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    storageResources: storageResources,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
): lambda.Function {
    const name = "getAssetStatus";
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
            // The status probe authenticates with the deployment-wide VIEWER key,
            // the same credential the frontend streams with, so it can only ever
            // see the assets the viewer can play. It deliberately does NOT use the
            // Integration Key: that key resolves to its owning Miris user's home
            // workspace, which is administratively mutable and can drift away from
            // the workspace holding the assets. The Integration Key stays with the
            // upload pipeline, which must create assets.
            MIRIS_VIEWER_KEY: config.app.miris.viewerKey,
        },
    });

    // Read-only: the asset record for Tier-2 authorization, and the Miris stream keys
    // stored as file metadata on the viewed file.
    storageResources.dynamo.assetStorageTable.grantReadData(fun);
    storageResources.dynamo.assetFileMetadataStorageTable.grantReadData(fun);

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
    fun.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["secretsmanager:GetSecretValue"],
            resources: [config.app.miris.apiKeySecretArn],
        })
    );

    // The table's stream, which carries the key IDs of TTL-deleted rows.
    viewerKeyTable.grantStreamRead(fun);

    kmsKeyLambdaPermissionAddToResourcePolicy(fun, storageResources.encryption.kmsKey);
    setupSecurityAndLoggingEnvironmentAndPermissions(fun, storageResources);
    globalLambdaEnvironmentsAndPermissions(fun, config);
    suppressCdkNagDynamoStreamListWildcard(fun);
    suppressCdkNagLambda(fun);

    return fun;
}
