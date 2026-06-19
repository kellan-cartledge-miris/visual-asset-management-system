/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { NestedStack } from "aws-cdk-lib";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import * as Config from "../../../../../config/config";
import { storageResources } from "../../../storage/storageBuilder-nestedStack";
import { MirisUploadConstruct } from "./constructs/mirisUpload-construct";

export interface MirisUploadBuilderNestedStackProps extends cdk.StackProps {
    config: Config.Config;
    storageResources: storageResources;
    vpc: ec2.IVpc;
    pipelineSubnets: ec2.ISubnet[];
    pipelineSecurityGroups: ec2.ISecurityGroup[];
    lambdaCommonBaseLayer: LayerVersion;
    importGlobalPipelineWorkflowFunctionName: string;
}

export class MirisUploadBuilderNestedStack extends NestedStack {
    public pipelineVamsLambdaFunctionName: string;

    constructor(parent: Construct, name: string, props: MirisUploadBuilderNestedStackProps) {
        super(parent, name);
        const construct = new MirisUploadConstruct(this, "MirisUpload", props);
        this.pipelineVamsLambdaFunctionName = construct.pipelineVamsLambdaFunctionName;
    }
}
