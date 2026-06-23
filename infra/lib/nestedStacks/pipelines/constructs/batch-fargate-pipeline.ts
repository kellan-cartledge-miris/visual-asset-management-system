/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as batch from "aws-cdk-lib/aws-batch";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as cdk from "aws-cdk-lib";
import * as Config from "../../../../config/config";
import { Construct } from "constructs";
import { CfnJobDefinition } from "aws-cdk-lib/aws-batch";
import { generateUniqueNameHash } from "../../../helper/security";
import path = require("path");

export interface BatchFargatePipelineConstructProps extends cdk.StackProps {
    config: Config.Config;
    vpc: ec2.IVpc;
    subnets: ec2.ISubnet[];
    securityGroups: ec2.ISecurityGroup[];
    jobRole: iam.Role;
    executionRole: iam.Role;
    imageAssetPath: string;
    dockerfileName: string;
    batchJobDefinitionName: string;
    /**
     * Ephemeral storage size in GiB for the Fargate container.
     * Fargate supports 21-200 GiB. Default is 60 GiB.
     */
    ephemeralStorageGiB?: number;
    /**
     * vCPU for the Fargate container. Default is 16. Valid combinations with memory
     * are constrained by Fargate; consult AWS docs when overriding. Useful for
     * right-sizing lightweight I/O-bound pipelines (e.g., Miris upload uses 1 vCPU).
     */
    cpu?: number;
    /**
     * Memory in MiB for the Fargate container. Default is 65536 (64 GiB). Must
     * match a valid Fargate vCPU/memory combination.
     */
    memoryMiB?: number;
    /**
     * Docker build platform for the container image. Default is LINUX_AMD64 (x86_64)
     * for shared toolchain compatibility. Set to LINUX_ARM64 to build a Graviton
     * image; must be paired with `fargateCpuArchitecture: ARM64`.
     */
    dockerPlatform?: cdk.aws_ecr_assets.Platform;
    /**
     * Fargate task CPU architecture. Default is X86_64. Set to ARM64 to run on
     * Graviton; must be paired with a Docker image built for LINUX_ARM64.
     */
    fargateCpuArchitecture?: ecs.CpuArchitecture;
}

const defaultProps: Partial<BatchFargatePipelineConstructProps> = {
    //stackName: "",
    //env: {},
};

export class BatchFargatePipelineConstruct extends Construct {
    public readonly batchJobDefinition: batch.IJobDefinition;
    public readonly batchJobQueue: batch.JobQueue;

    constructor(parent: Construct, name: string, props: BatchFargatePipelineConstructProps) {
        super(parent, name);

        props = { ...defaultProps, ...props };
        const region = cdk.Stack.of(this).region;
        const account = cdk.Stack.of(this).account;

        const batchEnvironment = new batch.FargateComputeEnvironment(
            this,
            "PipelineBatchComputeEnvironment",
            {
                vpc: props.vpc,
                vpcSubnets: props.vpc.selectSubnets({
                    subnets: props.subnets,
                }),
                securityGroups: props.securityGroups,
            }
        );

        // Docker container image. Default x86_64 keeps the toolchain identical to
        // the historical shared-pipeline behavior; pipelines that want Graviton
        // pass `dockerPlatform: LINUX_ARM64` (and the matching CPU architecture below).
        const containerImage = ecs.AssetImage.fromAsset(
            path.join(__dirname, props.imageAssetPath),
            {
                file: props.dockerfileName,
                platform: props.dockerPlatform ?? cdk.aws_ecr_assets.Platform.LINUX_AMD64,
            }
        );

        const batchJobName =
            props.batchJobDefinitionName +
            generateUniqueNameHash(
                props.config.env.coreStackName,
                props.config.env.account,
                props.batchJobDefinitionName,
                10
            );

        this.batchJobDefinition = new batch.EcsJobDefinition(this, "PipelineBatchJobDefinition", {
            jobDefinitionName: batchJobName,
            retryAttempts: 1,
            container: new batch.EcsFargateContainerDefinition(this, "PipelineBatchContainer", {
                cpu: props.cpu ?? 16,
                memory: cdk.Size.mebibytes(props.memoryMiB ?? 65536),
                ephemeralStorageSize: cdk.Size.gibibytes(props.ephemeralStorageGiB ?? 60),
                image: containerImage,
                fargateCpuArchitecture:
                    props.fargateCpuArchitecture ?? ecs.CpuArchitecture.X86_64,
                environment: {
                    AWS_REGION: region,
                    AWS_ACCOUNT: account,
                },
                jobRole: props.jobRole,
                executionRole: props.executionRole,
                user: "root",
            }),
        });

        this.batchJobQueue = new batch.JobQueue(this, "BatchJobQueue", {
            computeEnvironments: [
                {
                    computeEnvironment: batchEnvironment,
                    order: 1,
                },
            ],
        });
    }
}
