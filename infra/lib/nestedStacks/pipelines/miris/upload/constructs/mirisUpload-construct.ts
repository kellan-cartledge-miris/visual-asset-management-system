/* eslint-disable @typescript-eslint/no-unused-vars */
/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as cdk from "aws-cdk-lib";
import { Duration, Stack } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";
import * as path from "path";
import * as Config from "../../../../../../config/config";
import { storageResources } from "../../../../storage/storageBuilder-nestedStack";
import { BatchFargatePipelineConstruct } from "../../../constructs/batch-fargate-pipeline";
import * as ServiceHelper from "../../../../../helper/service-helper";
import * as s3AssetBuckets from "../../../../../helper/s3AssetBuckets";
import { Service } from "../../../../../helper/service-helper";
import {
    generateUniqueNameHash,
    kmsKeyPolicyStatementGenerator,
} from "../../../../../helper/security";
import {
    buildConstructMirisUploadPipelineFunction,
    buildMirisUploadGateFunction,
    buildMirisUploadPipelineEndFunction,
    buildOpenMirisUploadPipelineFunction,
    buildVamsExecuteMirisUploadFunction,
} from "../lambdaBuilder/mirisUploadFunctions";

export interface MirisUploadConstructProps extends cdk.StackProps {
    config: Config.Config;
    storageResources: storageResources;
    vpc: ec2.IVpc;
    pipelineSubnets: ec2.ISubnet[];
    pipelineSecurityGroups: ec2.ISecurityGroup[];
    lambdaCommonBaseLayer: LayerVersion;
    importGlobalPipelineWorkflowFunctionName: string;
}

const defaultProps: Partial<MirisUploadConstructProps> = {};

export class MirisUploadConstruct extends Construct {
    public pipelineVamsLambdaFunctionName: string;

    constructor(parent: Construct, name: string, props: MirisUploadConstructProps) {
        super(parent, name);

        props = { ...defaultProps, ...props };

        const region = Stack.of(this).region;
        const account = Stack.of(this).account;

        /**
         * Batch IAM Roles
         * The container needs: read from all VAMS asset buckets, Secrets Manager for the API key,
         * and Step Functions task token callbacks.
         */
        const inputBucketPolicy = new iam.PolicyDocument({
            statements: [
                ...s3AssetBuckets.getS3AssetBucketRecords().map((record) => {
                    const prefix = record.prefix || "/";
                    const normalizedPrefix = prefix.endsWith("/") ? prefix : prefix + "/";
                    return new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: ["s3:GetObject", "s3:HeadObject", "s3:ListBucket"],
                        resources: [
                            record.bucket.bucketArn,
                            `${record.bucket.bucketArn}${normalizedPrefix}*`,
                        ],
                    });
                }),
            ],
        });

        const outputBucketPolicy = new iam.PolicyDocument({
            statements: [
                new iam.PolicyStatement({
                    actions: ["s3:PutObject"],
                    resources: [
                        props.storageResources.s3.assetAuxiliaryBucket.bucketArn,
                        `${props.storageResources.s3.assetAuxiliaryBucket.bucketArn}/*`,
                    ],
                }),
            ],
        });

        const secretsPolicy = new iam.PolicyDocument({
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ["secretsmanager:GetSecretValue"],
                    resources: [props.config.app.miris.upload.apiKeySecretArn],
                }),
            ],
        });

        const stateTaskPolicy = new iam.PolicyDocument({
            statements: [
                new iam.PolicyStatement({
                    actions: [
                        "states:SendTaskSuccess",
                        "states:SendTaskFailure",
                        "states:SendTaskHeartbeat",
                    ],
                    resources: [`arn:${ServiceHelper.Partition()}:states:${region}:${account}:*`],
                }),
            ],
        });

        // Add KMS key access if a key is configured
        if (props.storageResources.encryption.kmsKey) {
            inputBucketPolicy.addStatements(
                kmsKeyPolicyStatementGenerator(props.storageResources.encryption.kmsKey)
            );
            outputBucketPolicy.addStatements(
                kmsKeyPolicyStatementGenerator(props.storageResources.encryption.kmsKey)
            );
        }

        const containerExecutionRole = new iam.Role(this, "MirisUploadContainerExecutionRole", {
            assumedBy: Service("ECS_TASKS").Principal,
            inlinePolicies: {
                InputBucketPolicy: inputBucketPolicy,
                OutputBucketPolicy: outputBucketPolicy,
                SecretsPolicy: secretsPolicy,
                StateTaskPolicy: stateTaskPolicy,
            },
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    "service-role/AmazonECSTaskExecutionRolePolicy"
                ),
                iam.ManagedPolicy.fromAwsManagedPolicyName("AWSXrayWriteOnlyAccess"),
            ],
        });

        const containerJobRole = new iam.Role(this, "MirisUploadContainerJobRole", {
            assumedBy: Service("ECS_TASKS").Principal,
            inlinePolicies: {
                InputBucketPolicy: inputBucketPolicy,
                OutputBucketPolicy: outputBucketPolicy,
                SecretsPolicy: secretsPolicy,
                StateTaskPolicy: stateTaskPolicy,
            },
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    "service-role/AmazonECSTaskExecutionRolePolicy"
                ),
                iam.ManagedPolicy.fromAwsManagedPolicyName("AWSXrayWriteOnlyAccess"),
            ],
        });

        /**
         * AWS Batch Fargate compute environment + job definition
         */
        const batchPipeline = new BatchFargatePipelineConstruct(
            this,
            "BatchFargatePipeline_MirisUpload",
            {
                config: props.config,
                vpc: props.vpc,
                subnets: props.pipelineSubnets,
                securityGroups: props.pipelineSecurityGroups,
                jobRole: containerJobRole,
                executionRole: containerExecutionRole,
                imageAssetPath: path.join(
                    "..",
                    "..",
                    "..",
                    "..",
                    "..",
                    "backendPipelines",
                    "miris",
                    "upload",
                    "container"
                ),
                dockerfileName: "Dockerfile",
                batchJobDefinitionName:
                    "MirisUploadJob" + props.config.name + "_" + props.config.app.baseStackName,
            }
        );

        /**
         * Inner Step Functions state machine
         *
         * Flow:
         *   constructPipelineTask
         *     → DuplicateCheck (choice)
         *         - DUPLICATE_DETECTED → DuplicateSucceed (terminal)
         *         - otherwise          → SubmitBatchJob → endTask
         *                              ↘ (on catch) → failState
         */
        const constructFn = buildConstructMirisUploadPipelineFunction(
            this,
            props.lambdaCommonBaseLayer,
            props.storageResources,
            props.config,
            props.vpc,
            props.pipelineSubnets
        );

        const endFn = buildMirisUploadPipelineEndFunction(
            this,
            props.lambdaCommonBaseLayer,
            props.storageResources,
            props.config,
            props.vpc,
            props.pipelineSubnets
        );

        const constructTask = new tasks.LambdaInvoke(this, "ConstructPipelineTask", {
            lambdaFunction: constructFn,
            outputPath: "$.Payload",
        });

        const submitBatchTask = new tasks.BatchSubmitJob(this, "SubmitMirisUploadBatchJob", {
            jobName: sfn.JsonPath.stringAt("$.jobName"),
            jobDefinitionArn: batchPipeline.batchJobDefinition.jobDefinitionArn,
            jobQueueArn: batchPipeline.batchJobQueue.jobQueueArn,
            containerOverrides: {
                command: [...sfn.JsonPath.listAt("$.definition")],
                environment: {
                    TASK_TOKEN: sfn.JsonPath.taskToken,
                    AWS_REGION: region,
                },
            },
            integrationPattern: sfn.IntegrationPattern.RUN_JOB,
        });

        const endTask = new tasks.LambdaInvoke(this, "MirisUploadEnd", {
            lambdaFunction: endFn,
            payload: sfn.TaskInput.fromObject({
                "externalSfnTaskToken.$": "$.externalSfnTaskToken",
                status: "success",
                "mirisAssetUuid.$": "$.mirisAssetUuid",
            }),
        });

        const failState = new sfn.Fail(this, "MirisUploadFail", {
            error: "MirisUploadFailed",
            cause: "See Batch / container logs for details.",
        });

        const duplicateSucceedState = new sfn.Succeed(this, "DuplicateAlreadyStreamed");

        submitBatchTask.addCatch(failState, { resultPath: "$.error" }).next(endTask);

        const duplicateCheck = new sfn.Choice(this, "DuplicateCheck")
            .when(
                sfn.Condition.stringEquals("$.status", "DUPLICATE_DETECTED"),
                duplicateSucceedState
            )
            .otherwise(submitBatchTask);

        const sfnDefinition = sfn.Chain.start(constructTask.next(duplicateCheck));

        /**
         * CloudWatch Log Group for the inner state machine
         */
        const stateMachineLogGroup = new logs.LogGroup(this, "MirisUploadStateMachineLogGroup", {
            logGroupName:
                "/aws/vendedlogs/VAMSstateMachine-MirisUploadPipeline" +
                generateUniqueNameHash(
                    props.config.env.coreStackName,
                    props.config.env.account,
                    "MirisUploadStateMachineLogGroup",
                    10
                ),
            retention: logs.RetentionDays.TEN_YEARS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        /**
         * Inner Step Functions state machine
         */
        const stateMachine = new sfn.StateMachine(this, "MirisUploadInnerStateMachine", {
            definitionBody: sfn.DefinitionBody.fromChainable(sfnDefinition),
            timeout: Duration.seconds(props.config.app.miris.upload.taskTimeoutSeconds + 1200),
            logs: {
                destination: stateMachineLogGroup,
                includeExecutionData: true,
                level: sfn.LogLevel.ALL,
            },
            tracingEnabled: true,
        });

        /**
         * Open pipeline Lambda — starts the inner SFN execution
         */
        const openFn = buildOpenMirisUploadPipelineFunction(
            this,
            props.lambdaCommonBaseLayer,
            props.storageResources,
            props.config,
            props.vpc,
            props.pipelineSubnets,
            stateMachine.stateMachineArn
        );
        stateMachine.grantStartExecution(openFn);

        /**
         * VAMS execute Lambda — entry point registered with VAMS pipeline system
         */
        const vamsExecuteFn = buildVamsExecuteMirisUploadFunction(
            this,
            props.lambdaCommonBaseLayer,
            props.storageResources,
            props.config,
            props.vpc,
            props.pipelineSubnets,
            openFn.functionName
        );

        /**
         * Gate Lambda — invoked by the outer workflow before vamsExecute to check
         * whether the pipeline should run for this asset/database combination
         */
        const gateFn = buildMirisUploadGateFunction(
            this,
            props.lambdaCommonBaseLayer,
            props.storageResources,
            props.config,
            props.vpc,
            props.pipelineSubnets
        );
        // Wire gate function name into the vamsExecute environment so it can invoke it
        vamsExecuteFn.addEnvironment("MIRIS_UPLOAD_GATE_FUNCTION_NAME", gateFn.functionName);
        gateFn.grantInvoke(vamsExecuteFn);

        /**
         * VAMS CustomResource auto-registration
         */
        if (props.config.app.miris.upload.autoRegisterWithVAMS) {
            const importFunction = lambda.Function.fromFunctionArn(
                this,
                "ImportFunction",
                `arn:${ServiceHelper.Partition()}:lambda:${region}:${account}:function:${
                    props.importGlobalPipelineWorkflowFunctionName
                }`
            );

            const importProvider = new cr.Provider(this, "ImportProvider", {
                onEventHandler: importFunction,
            });

            const currentTimestamp = new Date().toISOString();

            new cdk.CustomResource(this, "MirisUploadPipelineWorkflow", {
                serviceToken: importProvider.serviceToken,
                properties: {
                    timestamp: currentTimestamp,
                    pipelineId: "miris-upload-streamable",
                    pipelineDescription:
                        "Auto-upload USD assets to Miris Spatial Streaming and emit .mrx manifest",
                    pipelineType: "standardFile",
                    pipelineExecutionType: "Lambda",
                    assetType: ".all",
                    outputType: ".all",
                    waitForCallback: "Enabled",
                    lambdaName: vamsExecuteFn.functionName,
                    taskTimeout: String(props.config.app.miris.upload.taskTimeoutSeconds + 600),
                    taskHeartbeatTimeout: "",
                    inputParameters: "",
                    workflowId: "miris-upload-streamable",
                    workflowDescription: "Auto-upload USD assets to Miris Spatial Streaming",
                    autoTriggerOnFileExtensionsUpload: props.config.app.miris.upload
                        .autoRegisterAutoTriggerOnFileUpload
                        ? props.config.app.miris.upload.triggerExtensions
                        : "",
                },
            });

            NagSuppressions.addResourceSuppressions(
                importProvider,
                [
                    {
                        id: "AwsSolutions-IAM5",
                        reason:
                            "Wildcard permissions needed for pipelineWorkflow lambda import " +
                            "and execution for custom resource.",
                    },
                ],
                true
            );
        }

        this.pipelineVamsLambdaFunctionName = vamsExecuteFn.functionName;

        /**
         * CDK Nag suppressions
         */
        const nagReason =
            "Intended solution. The Miris upload pipeline lambda and container roles need " +
            "appropriate access to S3 and Step Functions for pipeline orchestration.";

        NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: nagReason,
                    appliesTo: [
                        {
                            regex: "^Resource::.*MirisUploadContainerExecutionRole/.*/g",
                        },
                    ],
                },
            ],
            true
        );

        NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: nagReason,
                    appliesTo: [
                        {
                            regex: "^Resource::.*MirisUploadContainerJobRole/.*/g",
                        },
                    ],
                },
            ],
            true
        );

        NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: nagReason,
                    appliesTo: [
                        {
                            regex: "^Resource::.*MirisUploadInnerStateMachine/Role/.*/g",
                        },
                    ],
                },
            ],
            true
        );
    }
}
