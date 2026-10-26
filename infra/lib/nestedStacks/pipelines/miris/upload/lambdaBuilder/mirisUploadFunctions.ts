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
import * as ServiceHelper from "../../../../../helper/service-helper";
import { vendedBatchJobLogGroupEnvironment } from "../../../../../helper/batchJobLogGroup";
import * as s3AssetBuckets from "../../../../../helper/s3AssetBuckets";
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

/**
 * Auxiliary-bucket prefix holding the dedup claim objects. Mirrors CLAIM_PREFIX in
 * backendPipelines/miris/upload/lambda/mirisClaim.py.
 */
const MIRIS_CLAIM_PREFIX = "locks/miris-upload";

/**
 * Suppresses the IAM5 finding for a function's grant on the claim prefix. The regex names that
 * prefix literally, so a wildcard on any other auxiliary-bucket key still surfaces at synth.
 */
function suppressCdkNagClaimPrefixWildcard(fun: lambda.Function) {
    NagSuppressions.addResourceSuppressions(
        fun,
        [
            {
                id: "AwsSolutions-IAM5",
                reason:
                    "Claim objects are keyed per asset and content fingerprint, known only at run time, under the " +
                    "fixed locks/miris-upload/ prefix of this deployment's auxiliary bucket.",
                appliesTo: [
                    {
                        regex: "/^Resource::<.*AssetAuxiliaryBucket.*\\.Arn>/locks/miris-upload/\\*$/g",
                    },
                ],
            },
        ],
        true
    );
}

/**
 * Lets a function release a claim: read its owner back, then delete it. Object actions on the claim
 * prefix only; the auxiliary bucket's KMS key is granted by kmsKeyLambdaPermissionAddToResourcePolicy.
 */
function grantClaimRelease(fun: lambda.Function, storageResources: storageResources) {
    fun.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["s3:GetObject", "s3:DeleteObject"],
            resources: [
                `${storageResources.s3.assetAuxiliaryBucket.bucketArn}/${MIRIS_CLAIM_PREFIX}/*`,
            ],
        })
    );
    suppressCdkNagClaimPrefixWildcard(fun);
}

/**
 * The object ARN of an imported external asset bucket, as the literal from config: an `aws*`
 * partition or its token, and a bucket segment of bucket-name characters only, so no wildcard ARN
 * matches.
 */
export const VAMS_EXECUTE_EXTERNAL_BUCKET_OBJECT_REGEX =
    "/^Resource::arn:(<AWS::Partition>|aws[a-z-]*):s3:::[a-z0-9][a-z0-9.-]*/\\*$/g";

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
        environment: {
            ALLOWED_INPUT_FILEEXTENSIONS: config.app.miris.upload.triggerExtensions,
        },
        ..._commonProps(config, vpc, subnets, lambdaCommonBaseLayer),
    });
    // The claim key fingerprints the keys and ETags of the asset's USD files, read from a listing.
    fun.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["s3:ListBucket"],
            resources: s3AssetBuckets
                .getS3AssetBucketRecords()
                .map((record) => record.bucket.bucketArn),
        })
    );
    fun.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["states:SendTaskSuccess"],
            resources: [
                `arn:${ServiceHelper.Partition()}:states:${config.env.region}:${
                    config.env.account
                }:*`,
            ],
        })
    );
    // The gate's object grants are scoped to the claim prefix. The read checks the owner of an
    // existing claim, telling a retry of its own put from another execution's.
    storageResources.s3.assetAuxiliaryBucket.grantPut(fun, `${MIRIS_CLAIM_PREFIX}/*`);
    storageResources.s3.assetAuxiliaryBucket.grantRead(fun, `${MIRIS_CLAIM_PREFIX}/*`);
    suppressCdkNagClaimPrefixWildcard(fun);
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
    // Releases the claim the gate wrote when the run cannot be handed off to the pipeline.
    storageResources.s3.assetAuxiliaryBucket.grantDelete(fun, `${MIRIS_CLAIM_PREFIX}/*`);
    suppressCdkNagClaimPrefixWildcard(fun);
    fun.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["states:SendTaskFailure"],
            resources: [
                `arn:${ServiceHelper.Partition()}:states:${config.env.region}:${
                    config.env.account
                }:*`,
            ],
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
            {
                id: "AwsSolutions-IAM5",
                reason: "Reads the workflow manifest and the asset's files, whose keys are known only at run time, in each configured asset bucket. An external bucket's ARN is the literal from config.",
                appliesTo: [{ regex: VAMS_EXECUTE_EXTERNAL_BUCKET_OBJECT_REGEX }],
            },
        ],
        true
    );
    return fun;
}

/** The Batch job definition name and the vended group its container writes to. */
export interface OpenPipelineBatchLogProps {
    jobDefinitionName: string;
    logGroup: logs.ILogGroup;
}

export function buildOpenMirisUploadPipelineFunction(
    scope: Construct,
    lambdaCommonBaseLayer: LayerVersion,
    storageResources: storageResources,
    config: Config.Config,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[],
    stateMachineArn: string,
    stateMachineLogGroup: logs.ILogGroup,
    batchLogs: OpenPipelineBatchLogProps
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
            // The container's vended log group and job definition name, registered as the Batch
            // state's log source (streams are `<jobDefinitionName>/default/<task-id>`).
            ...vendedBatchJobLogGroupEnvironment(batchLogs.logGroup),
            BATCH_JOB_DEFINITION_NAME: batchLogs.jobDefinitionName,
        },
        ..._commonProps(config, vpc, subnets, lambdaCommonBaseLayer),
    });
    fun.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["states:SendTaskFailure"],
            resources: [
                `arn:${ServiceHelper.Partition()}:states:${config.env.region}:${
                    config.env.account
                }:*`,
            ],
        })
    );
    // Releases the claim the gate wrote when the input is rejected or the state machine cannot start.
    grantClaimRelease(fun, storageResources);
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
            MIRIS_API_BASE_URL: config.app.miris.mirisApiBaseUrl,
            MIRIS_API_KEY_SECRET_ARN: config.app.miris.apiKeySecretArn,
            MIRIS_UPLOAD_TASK_TIMEOUT_SECONDS: String(config.app.miris.upload.taskTimeoutSeconds),
            MIRIS_UPLOAD_MAX_ASSET_SIZE_BYTES: String(config.app.miris.upload.maxAssetSizeBytes),
            ALLOWED_INPUT_FILEEXTENSIONS: config.app.miris.upload.triggerExtensions,
        },
        ..._commonProps(config, vpc, subnets, lambdaCommonBaseLayer),
    });
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
            resources: [
                `arn:${ServiceHelper.Partition()}:states:${config.env.region}:${
                    config.env.account
                }:*`,
            ],
        })
    );
    // A run that does not succeed releases its claim here, so the same content can be retried.
    grantClaimRelease(fun, storageResources);
    // A successful run lists the asset's claims to retire those on other content; the listing is
    // limited to the claim prefix.
    fun.addToRolePolicy(
        new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["s3:ListBucket"],
            resources: [storageResources.s3.assetAuxiliaryBucket.bucketArn],
            conditions: { StringLike: { "s3:prefix": [`${MIRIS_CLAIM_PREFIX}/*`] } },
        })
    );
    kmsKeyLambdaPermissionAddToResourcePolicy(fun, storageResources.encryption.kmsKey);
    setupSecurityAndLoggingEnvironmentAndPermissions(fun, storageResources);
    globalLambdaEnvironmentsAndPermissions(fun, config);
    suppressCdkNagLambda(fun);
    suppressCdkNagErrorsByGrantReadWrite(scope);
    return fun;
}
