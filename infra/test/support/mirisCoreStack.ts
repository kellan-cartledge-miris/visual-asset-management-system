/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A Miris-ENABLED core stack for tests.
 *
 * The committed infra/config/config.json carries no `app.miris` key, so a plain synth never
 * instantiates the Miris construct. This deep-copies the commercial config template and overrides
 * the fields the Miris upload pipeline needs, mirroring infra.test.ts's pattern.
 */

import * as cdk from "aws-cdk-lib";
import * as Infra from "../../lib/core-stack";
import * as Config from "../../config/config";
import * as Service from "../../lib/helper/service-helper";
import commercialTemplate from "../../config/config.template.commercial.json";

export const createMirisMockConfig = (mutate?: (config: Config.Config) => void): Config.Config => {
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
    config.app.miris.apiKeySecretArn =
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

    mutate?.(config);
    return config;
};

/**
 * Build the core stack under `app` with the Miris upload pipeline enabled, after applying `mutate`
 * to the config.
 *
 * The construct id must match `stackName` -- core-stack.ts's NagSuppressions path
 * (`/${stackName}/ApiBuilder2/...`) assumes the two agree, as bin/infra.ts always does.
 */
export function newMirisCoreStack(
    app: cdk.App,
    description: string,
    mutate?: (config: Config.Config) => void
): Infra.CoreVAMSStack {
    const mockConfig = createMirisMockConfig(mutate);
    Service.SetConfig(mockConfig);
    return new Infra.CoreVAMSStack(app, mockConfig.app.baseStackName, {
        env: {
            account: mockConfig.env.account,
            region: mockConfig.env.region,
        },
        stackName: mockConfig.app.baseStackName,
        ssmWafArnRegional: "",
        ssmWafArnCloudfront: "",
        config: mockConfig,
        description,
    });
}

/** The context every Miris synth test builds its app with. */
export const MIRIS_TEST_APP_CONTEXT = {
    environments: {
        common: { SolutionName: "AWSVisualAssetManagementSystem" },
        aws: { PermissionBoundaryArn: "", IamRoleNamePrefix: "" },
    },
};
