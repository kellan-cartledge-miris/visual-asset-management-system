# Miris Auto-Upload Pipeline

The Miris Auto-Upload Pipeline streams supported USD source assets into the [Miris Spatial Streaming](https://miris.com) platform and emits a `.mrx` manifest back to the asset's file list, so the asset becomes streamable in the VAMS Miris viewer. It auto-registers as a standard VAMS pipeline and GLOBAL workflow (`miris-upload`) with a `fileUpload` trigger, so it runs automatically when a matching USD file is uploaded, or on demand from the file manager's **Automation -> Execute Workflow** action against the asset's root USD source file.

For the end-to-end integration (viewer plugins, configuration, architecture), see the [Miris Spatial Streaming Integration](../../../documentation/docusaurus-site/docs/developer/external-integrations/miris-spatial-streaming.md) guide.

## Pipeline Components

### Container (`container/`)

-   **`__main__.py`** - Entrypoint; runs the 6-step Miris upload flow and writes the `.mrx` manifest
-   **`usd_packager.py`** - USD dependency resolution and `.usdz` packaging via OpenUSD (`UsdUtils.ComputeAllDependencies`)
-   **`miris_uploader.py`** - Miris content API client (`MirisClient`): start upload, mark complete, poll, generate
-   **`utils/secrets.py`** - Retrieves the Miris Integration Key from AWS Secrets Manager
-   **`Dockerfile`** / **`entrypoint.sh`** - x86_64 image (the `usd-core` wheel has no aarch64 build)

### Lambda Functions (`lambda/`)

-   **`mirisUploadGate.py`** - Collapses a per-file trigger fan-out to a single upload: a multi-file USD asset can fire the `fileUpload` trigger once per matching layer, and the gate claims the asset+version with a conditional S3 put so only the first execution proceeds
-   **`mirisClaim.py`** - Claim-key derivation and release, shared by the gate and every path that releases a claim
-   **`vamsExecuteMirisUpload.py`** - VAMS API integration; invokes the gate, then the pipeline
-   **`openMirisUploadPipeline.py`** - Starts the inner Step Functions execution; rejects folder inputs (requires a single file)
-   **`constructMirisUploadPipeline.py`** - Builds the AWS Batch job definition from the pipeline payload
-   **`pipelineEnd.py`** - Reports the workflow callback (`SendTaskSuccess` / `SendTaskFailure`) and releases the claim when the run did not succeed

### CDK Infrastructure (`../../../infra/lib/nestedStacks/pipelines/miris/upload/`)

-   **`mirisUploadBuilder-nestedStack.ts`** - Main CDK stack definition
-   **`constructs/mirisUpload-construct.ts`** - Core pipeline infrastructure (AWS Batch, Step Functions, workflow auto-registration)
-   **`lambdaBuilder/mirisUploadFunctions.ts`** - Lambda function definitions

## Pipeline Process

1. **Gate check**

    - The gate Lambda claims the asset's `(assetId, currentVersionId)` pair with a conditional S3 put (`If-None-Match: *`) at `s3://<auxiliary-bucket>/locks/miris-upload/<assetId>/<currentVersionId>.claim`. The first execution to reach the gate wins the claim and proceeds; every other execution triggered by the same asset version (for example, several `.usd` layers uploaded together) receives `PreconditionFailed`, reports its workflow task token as skipped, and exits as a no-op — so one asset version produces exactly one Miris upload regardless of how many files triggered it.
    - A run that does not succeed releases its claim, so the asset version stays eligible. A successful run keeps it; delete the claim object to re-upload the same asset version.

2. **Download and resolve**

    - Downloads the asset folder from S3, preserving relative layout so USD references resolve.
    - Resolves the root USD file; for a multi-file root, computes all dependencies. Fails fast on unresolved (absolute-path) references.

3. **Package**

    - A multi-file USD root is packaged into a single self-contained `.usdz` (the Miris content API accepts one file per asset). A `.usdz`, or a dependency-free USD, is uploaded as-is.

4. **Upload to Miris**

    - `POST /v1/content` to start the upload and obtain a Miris asset UUID + short-lived STS credentials.
    - SigV4-signed S3 `PUT` to the Miris temp endpoint (object key matches the declared `content_path` verbatim).
    - `PUT /v1/content/{id}` to mark the upload complete, then trigger streamable processing.

5. **Poll and emit**

    - Polls until Miris reaches a terminal preview/streamable state.
    - Writes a `.mrx` manifest (`mirisAssetUuid = <id>`) to the asset's output files path.

## Configuration Parameters

Configured under `app.miris.upload.*` in `infra/config/config.json`:

-   `enabled` - Deploys the pipeline and enables the `MIRIS_UPLOAD` feature
-   `apiKeySecretArn` - AWS Secrets Manager ARN holding the Miris Integration Key
-   `mirisApiBaseUrl` - Miris content API base URL (default `https://app.miris.com`)
-   `triggerExtensions` - Auto-trigger extensions (default `.usd,.usda,.usdc,.usdz`)
-   `taskTimeoutSeconds` - Maximum time the container waits for Miris processing
-   `maxAssetSizeBytes` - Maximum source asset size accepted
-   `autoRegisterWithVAMS` / `autoRegisterAutoTriggerOnFileUpload` - Workflow auto-registration and upload auto-trigger

## AWS Resources

-   **AWS Batch** (Fargate) - Runs the upload container
-   **Step Functions** - Pipeline orchestration
-   **Lambda** - Gate, execute, construct, open, and end handlers
-   **Amazon S3** - Asset input and `.mrx` output storage
-   **AWS Secrets Manager** - Miris Integration Key
-   **Amazon ECR** - Container image storage

## Usage

1. Upload a USD asset (`.usd`, `.usda`, `.usdc`, `.usdz`) to a VAMS asset — the auto-registered trigger fires and the pipeline starts. A multi-file asset made up of several standalone `.usd`/`.usda`/`.usdc` layers can fire the trigger once per layer; the gate collapses that fan-out so the asset is uploaded exactly once. To launch the pipeline on demand instead, select the asset's root USD source file in the file manager and choose **Automation -> Execute Workflow**, then pick the **Miris Spatial Streaming Upload** workflow and the **Stream with Miris** template. The workflow takes a single file, so a whole-asset (`/`) selection is rejected in the execute wizard.
2. The pipeline uploads the asset to Miris and waits for processing (typically 1–2 hours).
3. When processing completes, a `.mrx` manifest appears in the asset's file list.
4. Open the `.mrx` or the USD source file in the Miris viewer to stream the asset.

See `SMOKE_TEST.md` in this directory for manual verification steps.

## Requirements

-   `app.miris.enabled` and `app.miris.upload.enabled` set to `true`
-   `app.webUi.allowUnsafeEvalFeatures` set to `true` (the Miris SDK requires the `unsafe-eval` CSP directive)
-   Miris Integration Key stored in AWS Secrets Manager, referenced by `app.miris.upload.apiKeySecretArn`
-   Cannot be enabled in GovCloud or air-gapped deployments
