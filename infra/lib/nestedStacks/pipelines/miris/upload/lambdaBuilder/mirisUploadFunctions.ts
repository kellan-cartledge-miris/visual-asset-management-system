/* eslint-disable @typescript-eslint/no-unused-vars */
/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import * as path from "path";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { NagSuppressions } from "cdk-nag";
import * as Config from "../../../../../../config/config";
import { LAMBDA_PYTHON_RUNTIME } from "../../../../../../config/config";
import { storageResources } from "../../../../storage/storageBuilder-nestedStack";
import {
    grantReadPermissionsToAllAssetBuckets,
    kmsKeyLambdaPermissionAddToResourcePolicy,
    setupSecurityAndLoggingEnvironmentAndPermissions,
    globalLambdaEnvironmentsAndPermissions,
    suppressCdkNagLambda,
    suppressCdkNagErrorsByGrantReadWrite,
} from "../../../../../helper/security";

const LAMBDA_SRC = path.join(
    __dirname,
    "../../../../../../../backendPipelines/miris/upload/lambda"
);

function _commonProps(
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[],
    lambdaCommonBaseLayer: LayerVersion
) {
    return {
        runtime: LAMBDA_PYTHON_RUNTIME,
        layers: [lambdaCommonBaseLayer],
        timeout: Duration.minutes(15),
        memorySize: Config.LAMBDA_MEMORY_SIZE,
        vpc:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? vpc
                : undefined,
        vpcSubnets:
            config.app.useGlobalVpc.enabled && config.app.useGlobalVpc.useForAllLambdas
                ? { subnets }
                : undefined,
    };
}

export function buildMirisUploadGateFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    storageResources: storageResources,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
): lambda.Function {
    const fun = new lambda.Function(scope, "mirisUploadGate", {
        code: lambda.Code.fromAsset(LAMBDA_SRC),
        handler: "mirisUploadGate.lambda_handler",
        ..._commonProps(config, vpc, subnets, lambdaCommonBaseLayer),
    });
    fun.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["states:SendTaskSuccess"],
            resources: ["*"],
        })
    );
    storageResources.s3.assetAuxiliaryBucket.grantPut(fun);
    kmsKeyLambdaPermissionAddToResourcePolicy(fun, storageResources.encryption.kmsKey);
    setupSecurityAndLoggingEnvironmentAndPermissions(fun, storageResources);
    globalLambdaEnvironmentsAndPermissions(fun, config);
    suppressCdkNagLambda(fun);
    suppressCdkNagErrorsByGrantReadWrite(scope);
    return fun;
}

export function buildVamsExecuteMirisUploadFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    storageResources: storageResources,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[],
    openPipelineFunctionName: string
): lambda.Function {
    const fun = new lambda.Function(scope, "vamsExecuteMirisUpload", {
        code: lambda.Code.fromAsset(LAMBDA_SRC),
        handler: "vamsExecuteMirisUpload.lambda_handler",
        environment: {
            OPEN_PIPELINE_FUNCTION_NAME: openPipelineFunctionName,
            ASSET_STORAGE_TABLE_NAME: storageResources.dynamo.assetStorageTable.tableName,
        },
        ..._commonProps(config, vpc, subnets, lambdaCommonBaseLayer),
    });
    fun.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["lambda:InvokeFunction"],
            resources: [
                `arn:${cdk.Aws.PARTITION}:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:${openPipelineFunctionName}`,
            ],
        })
    );
    // The handler resolves its inputs from the workflow manifest, which lives in the asset bucket
    // (or the auxiliary bucket for an auxiliary-scoped manifest).
    grantReadPermissionsToAllAssetBuckets(fun);
    storageResources.s3.assetAuxiliaryBucket.grantRead(fun);
    storageResources.dynamo.assetStorageTable.grantReadData(fun);
    fun.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["states:SendTaskFailure"],
            resources: ["*"],
        })
    );
    kmsKeyLambdaPermissionAddToResourcePolicy(fun, storageResources.encryption.kmsKey);
    setupSecurityAndLoggingEnvironmentAndPermissions(fun, storageResources);
    globalLambdaEnvironmentsAndPermissions(fun, config);
    suppressCdkNagLambda(fun);
    suppressCdkNagErrorsByGrantReadWrite(scope);
    NagSuppressions.addResourceSuppressions(
        fun,
        [
            {
                id: "AwsSolutions-IAM5",
                reason: "Step Functions task tokens are not addressable by ARN, so reporting a callback failure requires a wildcard resource. Scope is limited to the token this function itself receives from the workflow.",
                appliesTo: ["Resource::*"],
            },
        ],
        true
    );
    return fun;
}

export function buildOpenMirisUploadPipelineFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    storageResources: storageResources,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[],
    stateMachineArn: string,
    stateMachineLogGroup: logs.ILogGroup
): lambda.Function {
    const fun = new lambda.Function(scope, "openMirisUploadPipeline", {
        code: lambda.Code.fromAsset(LAMBDA_SRC),
        handler: "openMirisUploadPipeline.lambda_handler",
        environment: {
            STATE_MACHINE_ARN: stateMachineArn,
            ALLOWED_INPUT_FILEEXTENSIONS: config.app.miris.upload.triggerExtensions,
            ORCHESTRATION_BUS_NAME: storageResources.eventBridge.orchestrationBus.eventBusName,
            STATE_MACHINE_LOG_GROUP_NAME: stateMachineLogGroup.logGroupName,
            STATE_MACHINE_LOG_GROUP_ARN: stateMachineLogGroup.logGroupArn,
        },
        ..._commonProps(config, vpc, subnets, lambdaCommonBaseLayer),
    });
    fun.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["states:StartExecution", "states:SendTaskFailure"],
            resources: ["*"],
        })
    );
    storageResources.eventBridge.orchestrationBus.grantPutEventsTo(fun);
    kmsKeyLambdaPermissionAddToResourcePolicy(fun, storageResources.encryption.kmsKey);
    setupSecurityAndLoggingEnvironmentAndPermissions(fun, storageResources);
    globalLambdaEnvironmentsAndPermissions(fun, config);
    suppressCdkNagLambda(fun);
    suppressCdkNagErrorsByGrantReadWrite(scope);
    return fun;
}

export function buildConstructMirisUploadPipelineFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    storageResources: storageResources,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
): lambda.Function {
    const fun = new lambda.Function(scope, "constructMirisUploadPipeline", {
        code: lambda.Code.fromAsset(LAMBDA_SRC),
        handler: "constructMirisUploadPipeline.lambda_handler",
        environment: {
            MIRIS_API_BASE_URL: config.app.miris.upload.mirisApiBaseUrl,
            MIRIS_API_KEY_SECRET_ARN: config.app.miris.upload.apiKeySecretArn,
            MIRIS_UPLOAD_TASK_TIMEOUT_SECONDS: String(config.app.miris.upload.taskTimeoutSeconds),
            MIRIS_UPLOAD_MAX_ASSET_SIZE_BYTES: String(config.app.miris.upload.maxAssetSizeBytes),
        },
        ..._commonProps(config, vpc, subnets, lambdaCommonBaseLayer),
    });
    storageResources.s3.assetAuxiliaryBucket.grantReadWrite(fun);
    kmsKeyLambdaPermissionAddToResourcePolicy(fun, storageResources.encryption.kmsKey);
    setupSecurityAndLoggingEnvironmentAndPermissions(fun, storageResources);
    globalLambdaEnvironmentsAndPermissions(fun, config);
    suppressCdkNagLambda(fun);
    suppressCdkNagErrorsByGrantReadWrite(scope);
    return fun;
}

export function buildMirisUploadPipelineEndFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    storageResources: storageResources,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[]
): lambda.Function {
    const fun = new lambda.Function(scope, "mirisUploadPipelineEnd", {
        code: lambda.Code.fromAsset(LAMBDA_SRC),
        handler: "pipelineEnd.lambda_handler",
        ..._commonProps(config, vpc, subnets, lambdaCommonBaseLayer),
    });
    fun.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["states:SendTaskSuccess", "states:SendTaskFailure"],
            resources: ["*"],
        })
    );
    kmsKeyLambdaPermissionAddToResourcePolicy(fun, storageResources.encryption.kmsKey);
    setupSecurityAndLoggingEnvironmentAndPermissions(fun, storageResources);
    globalLambdaEnvironmentsAndPermissions(fun, config);
    suppressCdkNagLambda(fun);
    suppressCdkNagErrorsByGrantReadWrite(scope);
    return fun;
}
