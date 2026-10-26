/* eslint-disable @typescript-eslint/no-unused-vars */
/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as cdk from "aws-cdk-lib";
import { Duration, Stack } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";
import * as path from "path";
import * as Config from "../../../../../../config/config";
import { storageResources } from "../../../../storage/storageBuilder-nestedStack";
import { BatchFargatePipelineConstruct } from "../../../constructs/batch-fargate-pipeline";
import { VamsSchemaRegistration } from "../../../constructs/vamsSchemaRegistration-construct";
import * as ServiceHelper from "../../../../../helper/service-helper";
import * as s3AssetBuckets from "../../../../../helper/s3AssetBuckets";
import { Service } from "../../../../../helper/service-helper";
import {
    NAG_REASON_ECS_TASK_EXECUTION_MANAGED,
    generateUniqueNameHash,
    grantExternalAssetBucketKmsKeys,
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
    importGlobalPipelineWorkflowV2FunctionName: string;
}

const defaultProps: Partial<MirisUploadConstructProps> = {};

/**
 * The container's work beyond the Miris processing wait (`taskTimeoutSeconds`): downloading and
 * packaging the asset, the upload itself and writing the stream metadata.
 */
export const MIRIS_UPLOAD_CONTAINER_OVERHEAD_SECONDS = 1200;

/**
 * Time the state machine allows beyond the Batch attempt: the job queue wait and the construct and
 * end Lambdas. The state machine must outlast the attempt, or its own timeout ends the execution
 * while the job still runs and no end state reports to the outer workflow.
 */
export const MIRIS_UPLOAD_ORCHESTRATION_MARGIN_SECONDS = 1800;

/**
 * IAM5 `appliesTo` patterns, anchored and narrow enough that no wildcard ARN can satisfy them. A
 * partition is the `<AWS::Partition>` token or a literal `aws*` partition; a bucket segment takes
 * bucket-name characters only.
 */
const PARTITION = "(<AWS::Partition>|aws[a-z-]*)";
const REGION = "(<AWS::Region>|[a-z]{2}(-[a-z]+)+-[0-9]+)";
const ACCOUNT = "(<AWS::AccountId>|[0-9]{12})";
const BUCKET_NAME = "[a-z0-9][a-z0-9.-]*";

/**
 * The job role's object grants: the asset bucket this deployment creates (its storage-stack
 * logical id `AssetBucket<hash>`, never the auxiliary bucket or a bucket policy) at the root prefix,
 * and an imported external bucket under its configured prefix.
 */
export const MIRIS_UPLOAD_JOB_ROLE_OBJECT_REGEXES = [
    "/^Resource::<AssetBucket[0-9A-F]{8}\\.Arn>/(pipelines/)?\\*$/g",
    `/^Resource::arn:${PARTITION}:s3:::${BUCKET_NAME}/([^*?/]+/)*\\*$/g`,
];

/** Batch job definitions and jobs in this deployment's own Region and account. */
export const MIRIS_UPLOAD_BATCH_JOB_DEFINITION_REGEX = `/^Resource::arn:${PARTITION}:batch:${REGION}:${ACCOUNT}:job-definition/\\*$/g`;
export const MIRIS_UPLOAD_BATCH_JOB_REGEX = `/^Resource::arn:${PARTITION}:batch:${REGION}:${ACCOUNT}:job/\\*$/g`;

/** The inner execution statuses whose end the state machine's own states cannot report. */
export const MIRIS_UPLOAD_UNREPORTED_EXECUTION_STATUSES = ["FAILED", "TIMED_OUT", "ABORTED"];

export class MirisUploadConstruct extends Construct {
    public pipelineVamsLambdaFunctionName: string;

    constructor(parent: Construct, name: string, props: MirisUploadConstructProps) {
        super(parent, name);

        props = { ...defaultProps, ...props };

        const region = Stack.of(this).region;
        const account = Stack.of(this).account;

        /**
         * Batch IAM roles
         *
         * The job role reads the asset from the asset buckets, writes the stream metadata under the
         * run's output path (`{baseAssetsPrefix}pipelines/...` in the default asset bucket) and reads
         * the Integration Key secret. The execution role only pulls the image and writes logs.
         */
        const assetBucketPolicy = new iam.PolicyDocument({
            statements: s3AssetBuckets.getS3AssetBucketRecords().flatMap((record) => {
                const prefix = record.prefix || "/";
                // {bucketArn}/{prefix}: the leading slash is stripped so the separator after the
                // bucket ARN is always present (the root prefix yields {bucketArn}/).
                const objectPrefix = (prefix.endsWith("/") ? prefix : prefix + "/").replace(
                    /^\/+/,
                    ""
                );
                return [
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: ["s3:ListBucket"],
                        resources: [record.bucket.bucketArn],
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: ["s3:GetObject", "s3:GetObjectVersion"],
                        resources: [`${record.bucket.bucketArn}/${objectPrefix}*`],
                    }),
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        actions: ["s3:PutObject"],
                        resources: [`${record.bucket.bucketArn}/${objectPrefix}pipelines/*`],
                    }),
                ];
            }),
        });
        if (props.storageResources.encryption.kmsKey) {
            assetBucketPolicy.addStatements(
                kmsKeyPolicyStatementGenerator(props.storageResources.encryption.kmsKey)
            );
        }

        const secretsPolicy = new iam.PolicyDocument({
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ["secretsmanager:GetSecretValue"],
                    resources: [props.config.app.miris.apiKeySecretArn],
                }),
            ],
        });

        const containerExecutionRole = new iam.Role(this, "MirisUploadContainerExecutionRole", {
            assumedBy: Service("ECS_TASKS").Principal,
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
                AssetBucketPolicy: assetBucketPolicy,
                SecretsPolicy: secretsPolicy,
            },
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    "service-role/AmazonECSTaskExecutionRolePolicy"
                ),
                iam.ManagedPolicy.fromAwsManagedPolicyName("AWSXrayWriteOnlyAccess"),
            ],
        });
        // Customer managed keys of external asset buckets (no-op when none are configured).
        grantExternalAssetBucketKmsKeys(containerJobRole);

        // The container's stdout/stderr: a named vended group under the /aws/vendedlogs/Pipelines/
        // prefix the execution-service role is granted to read, KMS-encrypted and retained for a year.
        const containerLogGroup = new logs.LogGroup(this, "MirisUploadBatchJobLogGroup", {
            logGroupName:
                "/aws/vendedlogs/Pipelines/MirisUpload" +
                generateUniqueNameHash(
                    props.config.env.coreStackName,
                    props.config.env.account,
                    "MirisUploadBatchJobLogGroup",
                    10
                ),
            encryptionKey: props.storageResources.encryption.kmsKey,
            retention: logs.RetentionDays.ONE_YEAR,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const attemptDurationSeconds =
            props.config.app.miris.upload.taskTimeoutSeconds +
            MIRIS_UPLOAD_CONTAINER_OVERHEAD_SECONDS;

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
                logGroup: containerLogGroup,
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
                // Sized for an I/O-bound workload (S3 download, HTTPS upload, state polling) on the
                // construct's default x86_64 platform: usd-core ships no aarch64 Linux wheel.
                cpu: 1,
                memoryMiB: 2048,
                ephemeralStorageGiB: 21,
                attemptDuration: Duration.seconds(attemptDurationSeconds),
            }
        );

        /**
         * Inner Step Functions state machine
         *
         * Flow:
         *   constructPipelineTask → SubmitBatchJob → endTask (SendTaskSuccess)
         *          │ on catch          │ on catch
         *          └─────────┬─────────┘
         *                    ▼
         *   endFailureTask (SendTaskFailure + claim release) → failState
         *
         * A timed-out or stopped execution reaches neither end task; the execution-ended rule below
         * runs the same end Lambda for it.
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
                    AWS_REGION: region,
                },
            },
            integrationPattern: sfn.IntegrationPattern.RUN_JOB,
            // Preserve the constructPipeline output (externalSfnTaskToken, etc.) so
            // MirisUploadEnd can read them. Without this the BatchSubmitJob result
            // replaces the entire state and the JSONPath '$.externalSfnTaskToken' is lost.
            resultPath: sfn.JsonPath.DISCARD,
        });

        const endTask = new tasks.LambdaInvoke(this, "MirisUploadEnd", {
            lambdaFunction: endFn,
            payload: sfn.TaskInput.fromObject({
                "externalSfnTaskToken.$": "$.externalSfnTaskToken",
                status: "success",
            }),
        });

        // Failure branch: the same end Lambda with a failure status, so the outer workflow's
        // callback token receives SendTaskFailure and the gate's claim is released before the
        // Fail state stops the execution.
        const endFailureTask = new tasks.LambdaInvoke(this, "MirisUploadEndFailure", {
            lambdaFunction: endFn,
            payload: sfn.TaskInput.fromObject({
                "externalSfnTaskToken.$": "$.externalSfnTaskToken",
                status: "failed",
                "errorType.$": "$.error.Error",
                "errorCause.$": "$.error.Cause",
                "assetId.$": "$.assetId",
                "assetVersionId.$": "$.assetVersionId",
                "inputOutputS3AssetAuxiliaryFilesPath.$": "$.inputOutputS3AssetAuxiliaryFilesPath",
            }),
            resultPath: sfn.JsonPath.DISCARD,
        });

        const failState = new sfn.Fail(this, "MirisUploadFail", {
            error: "MirisUploadFailed",
            cause: "See Batch / container logs for details.",
        });

        endFailureTask.next(failState);
        // A failure in either task carries the same state fields: constructPipeline returns the
        // claim fields it was given, so both catches resolve the same JSONPaths.
        constructTask.addCatch(endFailureTask, { resultPath: "$.error" });
        submitBatchTask.addCatch(endFailureTask, { resultPath: "$.error" }).next(endTask);

        const sfnDefinition = sfn.Chain.start(constructTask.next(submitBatchTask));

        /**
         * CloudWatch Log Group for the inner state machine
         */
        const stateMachineLogGroup = new logs.LogGroup(this, "MirisUploadStateMachineLogGroup", {
            encryptionKey: props.storageResources.encryption.kmsKey,
            logGroupName:
                "/aws/vendedlogs/VAMSstateMachine-MirisUploadPipeline" +
                generateUniqueNameHash(
                    props.config.env.coreStackName,
                    props.config.env.account,
                    "MirisUploadStateMachineLogGroup",
                    10
                ),
            retention: logs.RetentionDays.ONE_YEAR,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        /**
         * Inner Step Functions state machine
         */
        const stateMachine = new sfn.StateMachine(this, "MirisUploadInnerStateMachine", {
            definitionBody: sfn.DefinitionBody.fromChainable(sfnDefinition),
            timeout: Duration.seconds(
                attemptDurationSeconds + MIRIS_UPLOAD_ORCHESTRATION_MARGIN_SECONDS
            ),
            logs: {
                destination: stateMachineLogGroup,
                includeExecutionData: true,
                level: sfn.LogLevel.ALL,
            },
            tracingEnabled: true,
        });

        // Stopping the execution cancels the .sync Batch task, which terminates the running job; the
        // BatchSubmitJob task grants only batch:SubmitJob. DescribeJobs has no resource type; job ids
        // are generated at submit time, so TerminateJob is scoped to this account's jobs.
        stateMachine.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["batch:DescribeJobs"],
                resources: ["*"],
            })
        );
        stateMachine.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["batch:TerminateJob"],
                resources: [`arn:${ServiceHelper.Partition()}:batch:${region}:${account}:job/*`],
            })
        );

        // An execution that times out or is stopped never reaches its own end states, so its end is
        // reported from the status change: the end Lambda releases the claim and fails the outer
        // workflow's task token. A FAILED execution whose failure branch already reported meets a
        // closed token, which the Lambda treats as done.
        new events.Rule(this, "MirisUploadExecutionEndedRule", {
            description:
                "Releases the Miris upload claim and fails the workflow task when the inner execution ends unreported",
            eventPattern: {
                source: ["aws.states"],
                detailType: ["Step Functions Execution Status Change"],
                detail: {
                    status: MIRIS_UPLOAD_UNREPORTED_EXECUTION_STATUSES,
                    stateMachineArn: [stateMachine.stateMachineArn],
                },
            },
            targets: [new eventsTargets.LambdaFunction(endFn, { retryAttempts: 2 })],
        });

        /**
         * Open pipeline Lambda: starts the inner SFN execution
         */
        const openFn = buildOpenMirisUploadPipelineFunction(
            this,
            props.lambdaCommonBaseLayer,
            props.storageResources,
            props.config,
            props.vpc,
            props.pipelineSubnets,
            stateMachine.stateMachineArn,
            stateMachineLogGroup,
            {
                jobDefinitionName: batchPipeline.batchJobDefinition.jobDefinitionName,
                logGroup: containerLogGroup,
            }
        );
        stateMachine.grantStartExecution(openFn);

        /**
         * VAMS execute Lambda: the entry point registered with the VAMS pipeline system
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
         * Gate Lambda: invoked by vamsExecute to claim the asset's upload, so the per-file trigger
         * fan-out runs one upload
         */
        const gateFn = buildMirisUploadGateFunction(
            this,
            props.lambdaCommonBaseLayer,
            props.storageResources,
            props.config,
            props.vpc,
            props.pipelineSubnets
        );
        vamsExecuteFn.addEnvironment("MIRIS_UPLOAD_GATE_FUNCTION_NAME", gateFn.functionName);
        gateFn.grantInvoke(vamsExecuteFn);

        /**
         * VAMS vamsSchema auto-registration (V2 pipeline/workflow/template tables)
         */
        if (props.config.app.miris.upload.autoRegisterWithVAMS) {
            new VamsSchemaRegistration(this, "MirisUploadRegistration", {
                importFunctionName: props.importGlobalPipelineWorkflowV2FunctionName,
                artefactsBucket: props.storageResources.s3.artefactsBucket,
                vamsSchemaDir: path.join(
                    __dirname,
                    "..",
                    "..",
                    "..",
                    "..",
                    "..",
                    "..",
                    "..",
                    "backendPipelines",
                    "miris",
                    "upload",
                    "vamsSchema"
                ),
                resourceOverrides: { lambdaName: vamsExecuteFn.functionName },
                idOverrides: {
                    pipelineId: "miris-upload",
                    workflowId: "miris-upload",
                },
                triggerEnabled:
                    props.config.app.miris.upload?.autoRegisterAutoTriggerOnFileUpload === true,
            });
        }

        this.pipelineVamsLambdaFunctionName = vamsExecuteFn.functionName;

        /**
         * CDK Nag suppressions
         */
        NagSuppressions.addResourceSuppressions(
            containerExecutionRole,
            [
                { id: "AwsSolutions-IAM4", reason: NAG_REASON_ECS_TASK_EXECUTION_MANAGED },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "ecr:GetAuthorizationToken, which the ECS agent calls to pull the container image, supports no resource-level permissions.",
                    appliesTo: ["Resource::*"],
                },
            ],
            true
        );

        NagSuppressions.addResourceSuppressions(
            containerJobRole,
            [
                { id: "AwsSolutions-IAM4", reason: NAG_REASON_ECS_TASK_EXECUTION_MANAGED },
                {
                    id: "AwsSolutions-IAM5",
                    reason:
                        "The container reads the asset's files, whose keys are known only at run time, " +
                        "under each asset bucket's VAMS prefix, and writes the stream metadata only under " +
                        "that prefix's pipelines/ run-output area.",
                    // A bucket this deployment creates renders as a GetAtt, an imported external
                    // bucket as the literal ARN from config.
                    appliesTo: MIRIS_UPLOAD_JOB_ROLE_OBJECT_REGEXES.map((regex) => ({ regex })),
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "Encrypt and decrypt with the deployment's own KMS key; the wildcards are the GenerateDataKey and ReEncrypt action families on that one key.",
                    appliesTo: [{ regex: "/^Action::kms:(GenerateDataKey|ReEncrypt)\\*$/g" }],
                },
            ],
            true
        );

        // The .sync Batch integration and the state machine's own logging and tracing.
        NagSuppressions.addResourceSuppressions(
            stateMachine.role,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason:
                        "BatchSubmitJob grants SubmitJob on job-definition/* because Batch authorizes " +
                        "the revision-qualified ARN; Region and account are pinned, the queue is its own ARN.",
                    appliesTo: [{ regex: MIRIS_UPLOAD_BATCH_JOB_DEFINITION_REGEX }],
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason:
                        "Step Functions log delivery (logs:*LogDelivery*, PutResourcePolicy, " +
                        "DescribeLogGroups), X-Ray trace write and batch:DescribeJobs support no " +
                        "resource-level permissions, so Resource must be '*'.",
                    appliesTo: ["Resource::*"],
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason:
                        "Cancelling the .sync Batch task terminates a job whose id is generated at submit " +
                        "time; Region and account are pinned.",
                    appliesTo: [{ regex: MIRIS_UPLOAD_BATCH_JOB_REGEX }],
                },
            ],
            true
        );
    }
}
