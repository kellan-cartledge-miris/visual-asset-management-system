/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `cdk synth` in this worktree never instantiates the Miris construct: the active
 * infra/config/config.json carries no `app.miris` key at all, so a plain `cdk synth` pass proves
 * nothing about the Miris CDK path (pipeline construct, VamsSchemaRegistration wiring, VPC/Batch
 * subnets). This test builds a Miris-ENABLED mock config — mirroring infra.test.ts's pattern of
 * deep-copying the commercial config template and overriding fields — and asserts the full core
 * stack (including the pipeline builder and its nested Miris upload stack) synthesizes.
 */

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as Infra from "../lib/core-stack";
import * as Config from "../config/config";
import * as Service from "../lib/helper/service-helper";
import commercialTemplate from "../config/config.template.commercial.json";

const createMirisMockConfig = (): Config.Config => {
    const config = JSON.parse(JSON.stringify(commercialTemplate)) as Config.Config;

    // Fixed synth environment.
    config.env.account = "123456789012";
    config.env.region = "us-east-1";
    config.env.partition = "aws";
    config.env.coreStackName = "vams-test-us-east-1";
    // Unlike infra.test.ts, do NOT set loadContextIgnoreVPCStacks: that flag skips the entire
    // API/search/pipeline/addon block in core-stack.ts, which is exactly the path the Miris
    // upload pipeline lives on.

    config.app.baseStackName = "vams-test";
    config.app.adminUserId = "test-admin";
    config.app.adminEmailAddress = "test@example.com";
    config.app.useWaf = false;
    config.app.addStackCloudTrailLogs = false;
    config.app.openSearch.useServerless.enabled = false;
    config.app.openSearch.useProvisioned.enabled = false;
    config.app.useLocationService.enabled = false;
    config.app.useCloudFront.enabled = false; // skip StaticWeb; out of scope for this test
    config.app.pipelines.useConversion3dBasic.enabled = false; // isolate to the Miris pipeline

    // The Miris upload pipeline runs on AWS Batch/Fargate, which needs real subnets.
    config.app.useGlobalVpc.enabled = true;

    // Satisfy getConfig()'s Miris validation block (config.ts, app.miris / app.miris.upload
    // sections) with obvious placeholder values -- never a real viewer key or secret.
    config.app.webUi.allowUnsafeEvalFeatures = true;
    config.app.miris.enabled = true;
    config.app.miris.viewerKey = "test-placeholder-viewer-key-000000";
    config.app.miris.upload.enabled = true;
    config.app.miris.upload.autoRegisterAutoTriggerOnFileUpload = false;
    config.app.miris.upload.apiKeySecretArn =
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-miris-api-key-AbCdEf";

    // Internal (non-public) Config fields normally set by getConfig().
    config.enableCdkNag = false;
    config.dockerDefaultPlatform = "";
    config.s3AdditionalBucketPolicyJSON = undefined;
    config.iamRoleCustomizationJSON = undefined;
    config.openSearchAssetIndexName = "assets1236";
    config.openSearchFileIndexName = "files1236";
    config.openSearchAssetIndexNameSSMParam = "/vams-test-us-east-1/aos/assetIndexName";
    config.openSearchFileIndexNameSSMParam = "/vams-test-us-east-1/aos/fileIndexName";
    config.openSearchDomainEndpointSSMParam = "/vams-test-us-east-1/aos/endPoint";
    config.locationServiceApiKeyArnSSMParam = "/vams-test-us-east-1/locationService/apiKeyArn";
    config.webUrlDeploymentSSMParam = "/vams-test-us-east-1/web/url";
    config.resourceNamesSSMParamPrefix = "/vams-test-us-east-1/resourceNames";

    return config;
};

test("Core stack synthesizes with the Miris upload pipeline enabled", () => {
    const app = new cdk.App({
        context: {
            environments: {
                common: { SolutionName: "AWSVisualAssetManagementSystem" },
                aws: { PermissionBoundaryArn: "", IamRoleNamePrefix: "" },
            },
        },
    });
    const mockConfig = createMirisMockConfig();
    Service.SetConfig(mockConfig);

    // The construct id must match `stackName` -- core-stack.ts's NagSuppressions path
    // (`/${stackName}/ApiBuilder2/...`) assumes the two agree, as bin/infra.ts always does.
    const stack = new Infra.CoreVAMSStack(app, mockConfig.app.baseStackName, {
        env: {
            account: mockConfig.env.account,
            region: mockConfig.env.region,
        },
        stackName: mockConfig.app.baseStackName,
        ssmWafArnRegional: "",
        ssmWafArnCloudfront: "",
        config: mockConfig,
        description: "Test stack for VAMS Miris upload pipeline",
    });

    // THEN -- the whole stack synthesizes to a non-empty CloudFormation template (proves no
    // cross-stack wiring errors anywhere in the graph, including the VamsSchemaRegistration
    // custom resource reaching a real vamsSchema/ directory on disk).
    const template = app.synth().getStackArtifact(stack.artifactId).template;
    expect(Object.keys(template.Resources ?? {}).length).toBeGreaterThan(0);

    // AND the Miris upload pipeline's own nested stack was actually created (not skipped by a
    // config or wiring regression) and contains its Batch job definition -- proof the construct
    // was exercised, rather than merely that some unrelated root resource exists.
    const pipelineBuilder = stack.node.findChild("PipelineBuilder");
    const mirisUploadBuilder = pipelineBuilder.node.findChild(
        "MirisUploadBuilderNestedStack"
    ) as cdk.NestedStack;
    const mirisTemplate = Template.fromStack(mirisUploadBuilder);
    mirisTemplate.resourceCountIs("AWS::Batch::JobDefinition", 1);
});
