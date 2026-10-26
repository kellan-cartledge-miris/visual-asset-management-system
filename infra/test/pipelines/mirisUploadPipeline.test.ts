/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Miris upload pipeline's timeouts, failure routes and IAM shape.
 *
 * Timeouts: the container, not the state machine, does the long work, and only the state machine's
 * end states report to the outer workflow. A state machine timeout at or below the Batch attempt
 * duration ends the execution while the job still runs, so no end state reports, the dedup claim is
 * never released and the outer task waits out its own 48-hour timeout. The state machine therefore
 * has to outlast the attempt by a margin for the queue wait and the Lambda tasks, and an EventBridge
 * rule on the inner execution's FAILED / TIMED_OUT / ABORTED status runs the end Lambda for the ends
 * no state can reach.
 *
 * IAM: the container reads the asset, writes the stream metadata under the run-output area and reads
 * the Integration Key secret. It makes no Step Functions call and touches no auxiliary-bucket object.
 *
 * Asserted on the nested stack of a Miris-enabled core stack, because the Miris lambda builders need
 * the full storage resources a per-construct harness does not carry.
 */

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
    MIRIS_UPLOAD_ORCHESTRATION_MARGIN_SECONDS,
    MIRIS_UPLOAD_CONTAINER_OVERHEAD_SECONDS,
} from "../../lib/nestedStacks/pipelines/miris/upload/constructs/mirisUpload-construct";
import {
    MIRIS_TEST_APP_CONTEXT,
    createMirisMockConfig,
    newMirisCoreStack,
} from "../support/mirisCoreStack";
import { newTestApp } from "../support/testApp";
import { parseAsl, singleStateMachine } from "../support/asl";

let template: Template;
let resources: Record<string, any>;
let taskTimeoutSeconds: number;

beforeAll(() => {
    const app = newTestApp({ context: MIRIS_TEST_APP_CONTEXT });
    const stack = newMirisCoreStack(app, "Test stack for the Miris upload pipeline shape");
    const nested = stack.node
        .findChild("PipelineBuilder")
        .node.findChild("MirisUploadBuilderNestedStack") as cdk.NestedStack;
    template = Template.fromStack(nested);
    resources = template.toJSON().Resources;
    taskTimeoutSeconds = createMirisMockConfig().app.miris.upload.taskTimeoutSeconds;
});

const byType = (type: string) =>
    Object.entries(resources).filter(([, r]) => r.Type === type) as [string, any][];

const roleId = (fragment: string): string => {
    const ids = byType("AWS::IAM::Role")
        .map(([id]) => id)
        .filter((id) => id.includes(fragment));
    expect(ids).toHaveLength(1);
    return ids[0];
};

const lambdaRoleId = (handler: string): string => {
    const fns = byType("AWS::Lambda::Function").filter(([, r]) => r.Properties.Handler === handler);
    expect(fns).toHaveLength(1);
    return fns[0][1].Properties.Role["Fn::GetAtt"][0];
};

/** Every statement attached to a role: its inline Policies and any AWS::IAM::Policy naming it. */
const statementsOf = (id: string): any[] => [
    ...(resources[id].Properties.Policies ?? []).flatMap((p: any) => p.PolicyDocument.Statement),
    ...byType("AWS::IAM::Policy")
        .filter(([, p]) => JSON.stringify(p.Properties.Roles ?? []).includes(`"${id}"`))
        .flatMap(([, p]) => p.Properties.PolicyDocument.Statement),
];

const actionsOf = (statement: any): string[] => [statement.Action].flat();

describe("Miris upload timeouts", () => {
    test("the state machine outlasts the Batch attempt by the orchestration margin", () => {
        const jobDefinitions = byType("AWS::Batch::JobDefinition");
        expect(jobDefinitions).toHaveLength(1);
        const attemptSeconds = jobDefinitions[0][1].Properties.Timeout.AttemptDurationSeconds;
        // The top-level TimeoutSeconds of the ASL is the execution timeout.
        const executionSeconds = parseAsl(singleStateMachine(template)).TimeoutSeconds;

        expect(typeof attemptSeconds).toBe("number");
        expect(typeof executionSeconds).toBe("number");
        expect(MIRIS_UPLOAD_ORCHESTRATION_MARGIN_SECONDS).toBeGreaterThanOrEqual(900);
        expect(executionSeconds).toBeGreaterThanOrEqual(
            attemptSeconds + MIRIS_UPLOAD_ORCHESTRATION_MARGIN_SECONDS
        );
    });

    test("the Batch attempt outlasts the Miris processing wait", () => {
        const attemptSeconds = byType("AWS::Batch::JobDefinition")[0][1].Properties.Timeout
            .AttemptDurationSeconds;
        expect(taskTimeoutSeconds).toBeGreaterThan(0);
        expect(attemptSeconds).toBe(taskTimeoutSeconds + MIRIS_UPLOAD_CONTAINER_OVERHEAD_SECONDS);
    });
});

describe("Miris upload failure routes", () => {
    test("an EventBridge rule runs the end Lambda when the inner execution ends unreported", () => {
        const stateMachineId = byType("AWS::StepFunctions::StateMachine")[0][0];
        const endFunctionId = byType("AWS::Lambda::Function").find(
            ([, r]) => r.Properties.Handler === "pipelineEnd.lambda_handler"
        )![0];

        const rules = byType("AWS::Events::Rule").filter(([, r]) =>
            JSON.stringify(r.Properties.EventPattern ?? {}).includes("aws.states")
        );
        expect(rules).toHaveLength(1);
        const rule = rules[0][1].Properties;

        expect(rule.EventPattern.source).toEqual(["aws.states"]);
        expect(rule.EventPattern["detail-type"]).toEqual([
            "Step Functions Execution Status Change",
        ]);
        expect([...rule.EventPattern.detail.status].sort()).toEqual([
            "ABORTED",
            "FAILED",
            "TIMED_OUT",
        ]);
        // Scoped to this pipeline's own state machine, not every execution in the account.
        expect(rule.EventPattern.detail.stateMachineArn).toEqual([{ Ref: stateMachineId }]);
        expect(rule.Targets).toHaveLength(1);
        expect(rule.Targets[0].Arn).toEqual({ "Fn::GetAtt": [endFunctionId, "Arn"] });

        // EventBridge may invoke the end Lambda.
        const permissions = byType("AWS::Lambda::Permission").filter(
            ([, p]) =>
                p.Properties.Principal === "events.amazonaws.com" &&
                JSON.stringify(p.Properties.FunctionName).includes(endFunctionId)
        );
        expect(permissions).toHaveLength(1);
    });

    test("the success end task hands the end Lambda the claim fields", () => {
        const asl = parseAsl(singleStateMachine(template));
        const payload = asl.States.MirisUploadEnd.Parameters.Payload;

        expect(payload.status).toBe("success");
        expect(payload["assetId.$"]).toBe("$.assetId");
        expect(payload["claimFingerprint.$"]).toBe("$.claimFingerprint");
        expect(payload["inputOutputS3AssetAuxiliaryFilesPath.$"]).toBe(
            "$.inputOutputS3AssetAuxiliaryFilesPath"
        );
    });

    test("the failure branch hands the end Lambda the error and cause separately, with the claim fields", () => {
        const asl = parseAsl(singleStateMachine(template));
        const payload = asl.States.MirisUploadEndFailure.Parameters.Payload;

        expect(payload["errorType.$"]).toBe("$.error.Error");
        expect(payload["errorCause.$"]).toBe("$.error.Cause");
        expect(payload["assetId.$"]).toBe("$.assetId");
        expect(payload["claimFingerprint.$"]).toBe("$.claimFingerprint");
        expect(payload["inputOutputS3AssetAuxiliaryFilesPath.$"]).toBe(
            "$.inputOutputS3AssetAuxiliaryFilesPath"
        );
    });

    test("the state machine can cancel its .sync Batch job", () => {
        const roleIds = byType("AWS::IAM::Role")
            .map(([id]) => id)
            .filter((id) => id.includes("InnerStateMachineRole"));
        expect(roleIds).toHaveLength(1);
        const actions = statementsOf(roleIds[0]).flatMap(actionsOf);
        expect(actions).toContain("batch:TerminateJob");
        expect(actions).toContain("batch:DescribeJobs");
    });
});

describe("Miris upload IAM", () => {
    test("no role in the pipeline grants the s3:HeadObject pseudo-action", () => {
        // HeadObject is authorized by s3:GetObject; s3:HeadObject is not an IAM action.
        expect(JSON.stringify(resources)).not.toContain("s3:HeadObject");
    });

    test("the container roles make no Step Functions call and touch no auxiliary-bucket object", () => {
        for (const id of [roleId("ContainerJobRole"), roleId("ContainerExecutionRole")]) {
            const statements = statementsOf(id);
            expect(statements.flatMap(actionsOf).filter((a) => a.startsWith("states:"))).toEqual(
                []
            );
            expect(JSON.stringify(statements)).not.toMatch(/AssetAuxiliaryBucket/);
        }
    });

    test("the execution role carries no inline policy of its own", () => {
        const role = resources[roleId("ContainerExecutionRole")].Properties;
        expect(role.Policies ?? []).toEqual([]);
        const actions = statementsOf(roleId("ContainerExecutionRole")).flatMap(actionsOf);
        expect(
            actions.filter((a) => a.startsWith("s3:") || a.startsWith("secretsmanager:"))
        ).toEqual([]);
    });

    test("the job role writes only s3:PutObject, and only under the run-output area", () => {
        const statements = statementsOf(roleId("ContainerJobRole"));
        const s3Actions = new Set(
            statements.flatMap(actionsOf).filter((a: string) => a.startsWith("s3:"))
        );
        expect([...s3Actions].sort()).toEqual([
            "s3:GetObject",
            "s3:GetObjectVersion",
            "s3:ListBucket",
            "s3:PutObject",
        ]);

        const writes = statements.filter((s) => actionsOf(s).includes("s3:PutObject"));
        expect(writes.length).toBeGreaterThan(0);
        for (const s of writes) {
            // Write and read never share a statement, so the write scope stays its own.
            expect(actionsOf(s)).toEqual(["s3:PutObject"]);
            for (const resource of [s.Resource].flat()) {
                expect(JSON.stringify(resource)).toMatch(/\/pipelines\/\*"/);
            }
        }
    });

    test("the job role reads the Integration Key secret it is configured with, and nothing else", () => {
        const secretStatements = statementsOf(roleId("ContainerJobRole")).filter((s) =>
            actionsOf(s).includes("secretsmanager:GetSecretValue")
        );
        expect(secretStatements).toHaveLength(1);
        expect(secretStatements[0].Resource).toBe(
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-miris-api-key-AbCdEf"
        );
    });

    test("the construct Lambda touches no S3 bucket", () => {
        const actions = statementsOf(lambdaRoleId("constructMirisUploadPipeline.lambda_handler"))
            .flatMap(actionsOf)
            .filter((a: string) => a.startsWith("s3:"));
        expect(actions).toEqual([]);
    });

    test.each(["openMirisUploadPipeline.lambda_handler", "pipelineEnd.lambda_handler"])(
        "%s reads and deletes claim objects only, under the claim prefix only",
        (handler) => {
            const s3Statements = statementsOf(lambdaRoleId(handler)).filter((s) =>
                actionsOf(s).some((a) => a.startsWith("s3:") && a !== "s3:ListBucket")
            );
            expect(s3Statements).toHaveLength(1);
            expect(actionsOf(s3Statements[0]).sort()).toEqual(["s3:DeleteObject", "s3:GetObject"]);
            const resources = [s3Statements[0].Resource].flat();
            expect(resources).toHaveLength(1);
            // {auxiliaryBucketArn}/locks/miris-upload/*
            const join = resources[0]["Fn::Join"];
            expect(join[0]).toBe("");
            expect(JSON.stringify(join[1][0])).toMatch(/AssetAuxiliaryBucket/);
            expect(join[1].slice(1)).toEqual(["/locks/miris-upload/*"]);
        }
    );

    test("the gate lists the asset buckets and writes objects only under the claim prefix", () => {
        const statements = statementsOf(lambdaRoleId("mirisUploadGate.lambda_handler"));
        const listing = statements.filter((s) => actionsOf(s).includes("s3:ListBucket"));
        expect(listing).toHaveLength(1);
        // Bucket ARNs only: a listing grant carries no object wildcard.
        expect(actionsOf(listing[0])).toEqual(["s3:ListBucket"]);
        for (const resource of [listing[0].Resource].flat()) {
            expect(JSON.stringify(resource)).not.toContain("*");
        }
        const writes = statements.filter((s) =>
            actionsOf(s).some((a: string) => a.startsWith("s3:Put"))
        );
        expect(writes.length).toBeGreaterThan(0);
        for (const s of writes) {
            expect(JSON.stringify(s.Resource)).toContain("/locks/miris-upload/*");
        }
    });

    test.each(["mirisUploadGate.lambda_handler", "constructMirisUploadPipeline.lambda_handler"])(
        "%s receives the trigger extensions that pick the fingerprinted files and the root candidates",
        (handler) => {
            const fns = byType("AWS::Lambda::Function").filter(
                ([, r]) => r.Properties.Handler === handler
            );
            expect(fns).toHaveLength(1);
            expect(fns[0][1].Properties.Environment.Variables.ALLOWED_INPUT_FILEEXTENSIONS).toBe(
                createMirisMockConfig().app.miris.upload.triggerExtensions
            );
        }
    );

    test("the end Lambda lists the auxiliary bucket only under the claim prefix", () => {
        const listing = statementsOf(lambdaRoleId("pipelineEnd.lambda_handler")).filter((s) =>
            actionsOf(s).includes("s3:ListBucket")
        );
        expect(listing).toHaveLength(1);
        expect(actionsOf(listing[0])).toEqual(["s3:ListBucket"]);
        expect(JSON.stringify(listing[0].Resource)).toMatch(/AssetAuxiliaryBucket/);
        expect(JSON.stringify(listing[0].Resource)).not.toContain("*");
        expect(listing[0].Condition).toEqual({
            StringLike: { "s3:prefix": ["locks/miris-upload/*"] },
        });
    });

    test("the open Lambda lists nothing", () => {
        const actions = statementsOf(
            lambdaRoleId("openMirisUploadPipeline.lambda_handler")
        ).flatMap(actionsOf);
        expect(actions).not.toContain("s3:ListBucket");
    });

    test("vamsExecute can read a claim's owner back before releasing it", () => {
        const actions = statementsOf(lambdaRoleId("vamsExecuteMirisUpload.lambda_handler")).flatMap(
            actionsOf
        );
        expect(actions).toContain("s3:GetObject*");
        expect(actions).toContain("s3:DeleteObject*");
    });

    test("the open Lambda starts only its own state machine", () => {
        const stateMachineId = byType("AWS::StepFunctions::StateMachine")[0][0];
        const starts = statementsOf(lambdaRoleId("openMirisUploadPipeline.lambda_handler")).filter(
            (s) => actionsOf(s).includes("states:StartExecution")
        );
        expect(starts).toHaveLength(1);
        expect(starts[0].Resource).toEqual({ Ref: stateMachineId });
    });

    test("each container-role IAM5 suppression names what it applies to", () => {
        for (const id of [roleId("ContainerJobRole"), roleId("ContainerExecutionRole")]) {
            const rules = (resources[id].Metadata?.cdk_nag?.rules_to_suppress ?? []).filter(
                (r: any) => r.id === "AwsSolutions-IAM5"
            );
            expect(rules.length).toBeGreaterThan(0);
            for (const rule of rules) {
                // A blanket IAM5 suppression would hide any wildcard added to the role later.
                expect(rule.applies_to?.length ?? 0).toBeGreaterThan(0);
                expect(rule.reason).not.toMatch(/Intended solution/);
                for (const target of rule.applies_to) {
                    // A regex string without its leading slash parses as a catch-all.
                    if (typeof target === "object") {
                        expect(target.regex.startsWith("/")).toBe(true);
                    }
                }
            }
        }
        // The job role's own suppression covers the run-output write scope.
        const jobRules = resources[roleId("ContainerJobRole")].Metadata.cdk_nag.rules_to_suppress;
        expect(
            jobRules.some(
                (r: any) =>
                    r.id === "AwsSolutions-IAM5" &&
                    /pipelines\/ run-output area/.test(r.reason) &&
                    r.applies_to.every(
                        (t: any) => typeof t === "object" && t.regex.startsWith("/^")
                    )
            )
        ).toBe(true);
    });
});
