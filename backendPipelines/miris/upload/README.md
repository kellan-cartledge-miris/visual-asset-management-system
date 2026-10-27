# Miris Auto-Upload Pipeline

The Miris Auto-Upload Pipeline uploads USD source assets to [Miris Spatial Streaming](https://miris.com) and records the resulting Miris asset as file metadata on the asset's root USD file, so the file becomes streamable in the VAMS Miris viewer. It auto-registers as a standard VAMS pipeline and GLOBAL workflow (`miris-upload`) with a `fileUpload` trigger, so it runs automatically when a matching USD file is uploaded, or on demand from the file manager's **Automation -> Execute Workflow** action against one of the asset's USD files.

For the end-to-end integration (viewer plugins, configuration, architecture), see the [Miris Spatial Streaming Integration](../../../documentation/docusaurus-site/docs/developer/external-integrations/miris-spatial-streaming.md) guide.

## Pipeline Components

### Container (`container/`)

-   **`__main__.py`** - Entrypoint; lists the asset under its resolved root, chooses the root USD file, checks the size limit, runs the 6-step Miris upload flow and writes the stream metadata for the root file
-   **`stream_metadata.py`** - Builds the stream metadata body and its `.metadata.json` key under the run's metadata output path
-   **`usd_packager.py`** - Root selection (the layer no other layer references), USD dependency resolution and `.usdz` packaging via OpenUSD (`UsdUtils.ComputeAllDependencies`)
-   **`upload_config.py`** - Reads the rendered template configuration (Miris asset name and tags) and drops tags with the reserved `vams-asset-` and `vams-database-` prefixes
-   **`miris_uploader.py`** - Miris content API client (`MirisClient`): start upload, mark complete, poll, generate, delete
-   **`utils/secrets.py`** - Retrieves the Miris Integration Key from AWS Secrets Manager
-   **`Dockerfile`** / **`entrypoint.sh`** - x86_64 image (the `usd-core` wheel has no aarch64 build)

### Lambda Functions (`lambda/`)

-   **`mirisUploadGate.py`** - Collapses a per-file trigger fan-out to a single upload: a multi-file USD asset can fire the `fileUpload` trigger once per matching layer, and the gate claims a fingerprint of the asset's USD files with a conditional S3 put so only the first execution proceeds; manual runs skip the claim
-   **`mirisClaim.py`** - Claim-key derivation and release, shared by the gate and every path that releases a claim
-   **`vamsExecuteMirisUpload.py`** - VAMS API integration; invokes the gate, then the pipeline
-   **`openMirisUploadPipeline.py`** - Starts the inner Step Functions execution; rejects folder inputs (requires a single file)
-   **`constructMirisUploadPipeline.py`** - Builds the AWS Batch job definition from the pipeline payload; fails the run before the job is submitted when `outputS3AssetMetadataPath` is missing
-   **`pipelineEnd.py`** - Reports the workflow callback (`SendTaskSuccess` / `SendTaskFailure`), releases the claim when the run did not succeed, and retires the asset's other claims when it did

### CDK Infrastructure (`../../../infra/lib/nestedStacks/pipelines/miris/upload/`)

-   **`mirisUploadBuilder-nestedStack.ts`** - Main CDK stack definition
-   **`constructs/mirisUpload-construct.ts`** - Core pipeline infrastructure (AWS Batch, Step Functions, workflow auto-registration)
-   **`lambdaBuilder/mirisUploadFunctions.ts`** - Lambda function definitions

## Pipeline Process

1. **Gate check**

    - A manual run (**Stream with Miris** from **Automation -> Execute Workflow**) always proceeds and writes no claim.
    - A triggered run lists the asset's files with a trigger extension under the asset root and fingerprints their asset-relative keys and ETags (SHA-256). The gate claims `s3://<auxiliary-bucket>/locks/miris-upload/<assetId>/<fingerprint>.claim` with a conditional S3 put (`If-None-Match: *`). The first execution to write it proceeds; every other execution for the same content (for example, several layers uploaded together, or a repeat trigger on unchanged files) receives `PreconditionFailed`, reports its workflow task token as skipped, and exits as a no-op.
    - A run that does not succeed releases its claim. A successful run keeps its claim and deletes the asset's claims on other content, so changed, added or reverted USD layers upload again. A change to non-USD files alone (textures) gives the same fingerprint; run **Stream with Miris** to upload it.

2. **List, size check, root selection and download**

    - Lists the asset under its resolved root (which carries `baseAssetsPrefix` or an existing-key location) and checks `maxAssetSizeBytes` from the listing before downloading: a lone `.usdz` root counts alone, otherwise every file under the root counts.
    - Chooses the root: the one file with a trigger extension that no other USD layer references (sublayers, references, payloads, value clips, asset-valued attributes), or the single `.usdz`. More than one candidate fails with `ambiguous_root` (exit 10); an unreadable layer fails with `unreadable_layer` (exit 11) and the log names the file.
    - Downloads the asset preserving its relative layout so USD references resolve, computes the root's dependencies, and fails fast on unresolved (absolute-path) references.

3. **Package**

    - A multi-file USD root is packaged into a single self-contained `.usdz` (the Miris content API accepts one file per asset). A `.usdz`, or a dependency-free USD, is uploaded as-is.

4. **Upload to Miris**

    - `POST /v1/content` to start the upload and obtain a Miris asset UUID + short-lived STS credentials.
    - SigV4-signed S3 `PUT` to the Miris temp endpoint (object key matches the declared `content_path` verbatim).
    - `PUT /v1/content/{id}` to mark the upload complete.

5. **Poll and emit**

    - Polls until Miris reaches a terminal preview/streamable state, then requests streamable processing (`POST /v1/asset/{id}/generate`, best effort).
    - Writes `{outputS3AssetMetadataPath}<relativeFilePath>.metadata.json`, where `<relativeFilePath>` is the root USD file's path within the asset root (for example `scenes/pump.usda`). The workflow's process-output step applies it to that file as an `update`, so other file metadata is kept.

## Output

The pipeline writes no asset files. It sets four file metadata keys on the asset's root USD file:

| Key                       | Type     | Value                                                                                     |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `miris_asset_uuid`        | `string` | The Miris asset UUID to stream                                                            |
| `miris_source_version_id` | `string` | S3 `VersionId` of the USD object the container downloaded; empty when the bucket has none |
| `miris_uploaded_at`       | `date`   | ISO 8601 UTC time the upload completed, for example `2026-10-14T09:30:00Z`                |
| `miris_display_name`      | `string` | Display name used for the Miris asset                                                     |

A later upload (a manual run, or a trigger on changed USD content) overwrites the four keys with the new Miris asset; the previous Miris asset is not deleted.

Every Miris asset the pipeline creates carries the tags `vams`, `vams-asset-{assetId}` and `vams-database-{databaseId}`. Template tags (`MIRIS_TAGS`) that begin with `vams-asset-` or `vams-database-` are dropped with a warning.

## Configuration Parameters

Configured under `app.miris.upload.*` in `infra/config/config.json`:

-   `enabled` - Deploys the pipeline and enables the `MIRIS_UPLOAD` feature
-   `triggerExtensions` - Auto-trigger extensions (default `.usd,.usda,.usdc,.usdz`); also the files the gate fingerprints and the container considers as root
-   `taskTimeoutSeconds` - Maximum time the container waits for Miris to report `preview` or `streamable`
-   `maxAssetSizeBytes` - Maximum source size, checked from the listing before download
-   `autoRegisterWithVAMS` / `autoRegisterAutoTriggerOnFileUpload` - Workflow auto-registration and upload auto-trigger

The pipeline also reads two settings shared with the Miris viewer, under `app.miris.*`:

-   `apiKeySecretArn` - AWS Secrets Manager ARN holding the Miris Integration Key
-   `mirisApiBaseUrl` - Miris API base URL (default `https://app.miris.com`)

`app.miris.upload.apiKeySecretArn` and `app.miris.upload.mirisApiBaseUrl` are accepted as deprecated aliases of these two settings.

## AWS Resources

-   **AWS Batch** (Fargate) - Runs the upload container
-   **Step Functions** - Pipeline orchestration
-   **Lambda** - Gate, execute, construct, open, and end handlers
-   **Amazon S3** - Asset input and stream metadata output storage
-   **AWS Secrets Manager** - Miris Integration Key
-   **Amazon ECR** - Container image storage

## Usage

1. Upload a USD asset (`.usd`, `.usda`, `.usdc`, `.usdz`) to a VAMS asset; the auto-registered trigger fires and the pipeline starts. A multi-file asset can fire the trigger once per layer; the gate collapses that fan-out so the content is uploaded once. To launch the pipeline on demand instead, select one of the asset's USD files in the file manager and choose **Automation -> Execute Workflow**, then pick the **Miris Spatial Streaming Upload** workflow and the **Stream with Miris** template. The workflow takes a single file, so a whole-asset (`/`) selection is rejected in the execute wizard.
2. The pipeline uploads the asset's root to Miris and waits until Miris reports it as `preview` or `streamable`, then requests streamable processing (typically 1–2 hours).
3. When the run completes, the `miris_*` keys appear in the root USD file's metadata.
4. Open the root USD file in the Miris viewer to stream the asset.

See `SMOKE_TEST.md` in this directory for manual verification steps.

## Requirements

-   `app.miris.enabled` and `app.miris.upload.enabled` set to `true`
-   `app.webUi.allowUnsafeEvalFeatures` set to `true` (the Miris SDK requires the `unsafe-eval` CSP directive)
-   Miris Integration Key stored in AWS Secrets Manager, referenced by `app.miris.apiKeySecretArn`
-   `app.useGlobalVpc.enabled` set to `true`; the Batch jobs reach Miris through the NAT gateway of the private subnets
-   Cannot be enabled when `app.govCloud.enabled` is `true` (the restricted partitions)
