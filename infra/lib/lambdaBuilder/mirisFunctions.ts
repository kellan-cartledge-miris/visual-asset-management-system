/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ec2 from "aws-cdk-lib/aws-ec2";
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
            ASSET_STORAGE_TABLE_NAME: storageResources.dynamo.assetStorageTable.tableName,
            MIRIS_API_BASE_URL: config.app.miris.upload.mirisApiBaseUrl,
            MIRIS_API_KEY_SECRET_ARN: config.app.miris.upload.apiKeySecretArn,
        },
    });

    storageResources.dynamo.assetStorageTable.grantReadData(fun);

    fun.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["secretsmanager:GetSecretValue"],
            resources: [config.app.miris.upload.apiKeySecretArn],
        })
    );

    kmsKeyLambdaPermissionAddToResourcePolicy(fun, storageResources.encryption.kmsKey);
    setupSecurityAndLoggingEnvironmentAndPermissions(fun, storageResources);
    globalLambdaEnvironmentsAndPermissions(fun, config);
    suppressCdkNagErrorsByGrantReadWrite(scope);

    return fun;
}
