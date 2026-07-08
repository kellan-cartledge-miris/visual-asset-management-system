# Miris Auto-Upload Pipeline

The Miris Auto-Upload Pipeline streams supported USD source assets into the [Miris Spatial Streaming](https://miris.com) platform and emits a `.mrx` manifest back to the asset's file list, so the asset becomes streamable in the VAMS Miris viewer. It runs automatically when a USD file is uploaded to an enabled database, or on demand via the **Stream with Miris** action in the viewer.

For the end-to-end integration (viewer plugins, configuration, architecture), see the [Miris Spatial Streaming Integration](../../../documentation/docusaurus-site/docs/developer/external-integrations/miris-spatial-streaming.md) guide.

## Pipeline Components

### Container (`container/`)

-   **`__main__.py`** - Entrypoint; runs the 6-step Miris upload flow and writes the `.mrx` manifest
-   **`usd_packager.py`** - USD dependency resolution and `.usdz` packaging via OpenUSD (`UsdUtils.ComputeAllDependencies`)
-   **`miris_uploader.py`** - Miris content API client (`MirisClient`): start upload, mark complete, poll, generate
-   **`pipeline_vams.py`** - VAMS pipeline definition parsing and output handling
-   **`utils/secrets.py`** - Retrieves the Miris Integration Key from AWS Secrets Manager
-   **`Dockerfile`** / **`entrypoint.sh`** - x86_64 image (the `usd-core` wheel has no aarch64 build)

### Lambda Functions (`lambda/`)

-   **`mirisUploadGate.py`** - Enforces the per-database allow-list; bypassed when `inputParameters.manual` is set (manual UI/CLI invocations)
-   **`vamsExecuteMirisUpload.py`** - VAMS API integration; invokes the gate, then the pipeline
-   **`openMirisUploadPipeline.py`** - Starts the inner Step Functions execution; rejects folder inputs (requires a single file)
-   **`constructMirisUploadPipeline.py`** - Builds the AWS Batch job definition from the pipeline payload
-   **`pipelineEnd.py`** - Handles pipeline completion and callback

### CDK Infrastructure (`../../../infra/lib/nestedStacks/pipelines/miris/upload/`)

-   **`mirisUploadBuilder-nestedStack.ts`** - Main CDK stack definition
-   **`constructs/mirisUpload-construct.ts`** - Core pipeline infrastructure (AWS Batch, Step Functions, workflow auto-registration)
-   **`lambdaBuilder/mirisUploadFunctions.ts`** - Lambda function definitions

## Pipeline Process

1. **Gate check**

    - The gate Lambda proceeds if the asset's database is in `enabledDatabaseIds`, or if the invocation is manual (`inputParameters.manual = true`); otherwise it skips.

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
-   `enabledDatabaseIds` - Databases whose USD uploads auto-trigger the pipeline (manual triggers bypass this list)
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

1. Upload a USD asset (`.usd`, `.usda`, `.usdc`, `.usdz`) to a VAMS asset in an enabled database, or open a USD file and click **Stream with Miris** in the viewer.
2. The pipeline uploads the asset to Miris and waits for processing (typically 1–2 hours).
3. When processing completes, a `.mrx` manifest appears in the asset's file list.
4. Open the `.mrx` or the USD source file in the Miris viewer to stream the asset.

See `SMOKE_TEST.md` in this directory for manual verification steps.

## Requirements

-   `app.miris.enabled` and `app.miris.upload.enabled` set to `true`
-   `app.webUi.allowUnsafeEvalFeatures` set to `true` (the Miris SDK requires the `unsafe-eval` CSP directive)
-   Miris Integration Key stored in AWS Secrets Manager, referenced by `app.miris.upload.apiKeySecretArn`
-   Cannot be enabled in GovCloud or air-gapped deployments
