# Miris Auto-Upload Pipeline

The Miris Auto-Upload pipeline streams supported source assets into the Miris Spatial Streaming platform and records the resulting Miris asset as [stream metadata](../developer/external-integrations/miris-spatial-streaming.md#stream-metadata) on the source USD file. Once the asset is on Miris, users can stream it from the VAMS viewer by opening the USD file.

## When it fires

The pipeline auto-registers as a GLOBAL VAMS workflow (`miris-upload`) with a `fileUpload` trigger, and runs in two ways:

-   **Automatically** — when a file with a supported extension is uploaded to a VAMS asset, provided `app.miris.upload.autoRegisterAutoTriggerOnFileUpload` is enabled. The trigger is GLOBAL, so it fires for uploads in any database; restricting it to specific databases is a matter of registering a database-scoped copy of the workflow instead of relying on the global one.
-   **On demand** — select the asset's root USD source file in the file manager and choose **Automation -> Execute Workflow**, then pick the **Miris Spatial Streaming Upload** workflow and its **Stream with Miris** template. See [Viewer Plugins Reference](../additional/viewer-plugins.md#miris-spatial-streaming-viewer).

Either trigger invokes the pipeline's workflow with the asset's **root USD file** as input. The workflow takes exactly one file: selecting the whole asset (`/`) blocks **Continue** in the execute wizard with "Workflow does not allow whole-asset ('/') selection", and folders are rejected for the same reason. A `fileUpload` trigger fires once per matching file, so a multi-file USD asset made up of several standalone USD layers can fan out to one execution per layer; the upload gate claims the asset's current version and lets only the first execution proceed, so the asset is uploaded to Miris exactly once regardless of how many files triggered it.

### Re-running the pipeline for an asset version

The claim the gate writes is keyed on the asset and its current version, and it persists after a successful upload — that record is what collapses the trigger fan-out. Any later run for the same asset version therefore completes immediately with a `skipped` result and does not re-upload.

A run that does not succeed releases its own claim, so a failed upload can simply be retried. To re-run a **successful** upload for the same asset version, delete the claim object from the auxiliary bucket:

```text
s3://<auxiliary-bucket>/locks/miris-upload/<assetId>/<currentVersionId>.claim
```

then launch the workflow again from **Automation -> Execute Workflow**. Creating a new asset version also produces a new claim key and re-runs the pipeline. Re-uploading files into an existing asset does not create an asset version, so it keeps the same claim key — delete the claim object to upload the revised geometry.

### Known limitation: which layer becomes the Miris root

On the automatic path the root layer is decided by whichever execution wins the claim race, not by inspecting the USD scene. For an asset holding several standalone USD layers that each match the trigger's filter, the layer that happens to claim first defines the upload, so a subtree can be streamed instead of the intended root — silently, since the upload itself succeeds.

For multi-layer assets, launch the pipeline explicitly from **Automation -> Execute Workflow** with the root USD file selected. That is the reliable route, because the selection names the root rather than leaving it to arrival order.

## Viewing the result

After upload, Miris processes the asset (typically 1–2 hours) before it becomes streamable. Once the pipeline has written the stream metadata, opening the USD file shows the Miris viewer, which displays a "preparing" overlay until the asset is ready and then streams it. See [Viewer plugin](../developer/external-integrations/miris-spatial-streaming.md#viewer-plugin) for the viewer's states and the banner it shows when the file has changed since it was streamed.

## What the pipeline writes

The pipeline adds no files to the asset. It writes one `.metadata.json` file to the run's metadata output path, at `{outputS3AssetMetadataPath}<relativeFilePath>.metadata.json`, where `<relativeFilePath>` is the USD file's path within the asset (for example `scenes/pump.usda`). The workflow's process-output step applies it to that file as `SYSTEM_USER` with `updateType: update`, so the file's other metadata keys are kept. The file carries the four stream metadata keys described in [Stream metadata](../developer/external-integrations/miris-spatial-streaming.md#stream-metadata): the Miris asset UUID, the Amazon S3 version ID of the USD object the container downloaded, the upload completion time, and the Miris asset name.

When the run's metadata output path is missing, the pipeline fails before it submits the AWS Batch job, so nothing is uploaded to Miris without a place to record the result.

-   **Re-running.** Running **Stream with Miris** again on the same file uploads a new Miris asset and overwrites the four keys with it. The previous Miris asset is not deleted; remove it in the Miris Portal if it is no longer needed.
-   **Output path extension.** The metadata file is applied to the path it is written at, relative to the run's output folder. The registered `miris-upload` workflow uses the default output path extension (`/`). A custom workflow that runs this pipeline with a `defaultOutputFileBaseExecutionPathExtension` (see [Pipelines and workflows](../concepts/pipelines-and-workflows.md)) shifts the path the metadata is applied to, so the keys do not land on the source USD file.

### Known limitation: assets created on an existing bucket folder

The pipeline derives the USD file's path within the asset from the position of the asset ID in the file's object key. An asset created on an existing bucket folder (`bucketExistingKey`) has no asset ID in its keys, so for a USD file in a subfolder of such an asset the metadata is written against the wrong path, and automatic streaming does not work for that file. Setting the stream metadata on the file by hand still works; see [Editing the stream metadata](../developer/external-integrations/miris-spatial-streaming.md#editing-the-stream-metadata).

## Supported source formats

`.usd`, `.usda`, `.usdc`, `.usdz`. Multi-file USD assets must be `.usdz` packaged — the Miris content API accepts only one file per upload.

## What the container does

1. POST /v1/content to start the upload, get a Miris asset ID and short-lived S3 STS credentials.
2. SigV4-signed PUT to the Miris temp S3 endpoint.
3. PUT /v1/content/\{id\} `{status: "completed"}` to mark upload complete.
4. Poll GET /v1/asset/\{id\} until the state field reaches a preview or streamable state.
5. POST /v1/asset/\{id\}/generate to trigger streamable processing.
6. Write the stream metadata file for the source USD file to the run's metadata output path (see [What the pipeline writes](#what-the-pipeline-writes)).

## Multi-file USD assets

A root `.usd`, `.usda`, or `.usdc` that references external files (textures,
sublayers) is automatically packaged into a single `.usdz` inside the pipeline
container before upload — Miris's content API accepts one self-contained file
per asset. Dependency discovery uses OpenUSD's `UsdUtils.ComputeAllDependencies`,
so only referenced files are included (incidental files like `.DS_Store` are
dropped). A `.usda/.usdc/.usd` with no external references is uploaded as-is;
a `.usdz` you upload directly is passed through unchanged.

**References must be relative.** If a root file references an absolute path
(e.g. `/Users/you/textures/wood.png`) the dependency cannot be resolved and the
pipeline fails fast with an `unresolved_references` log entry rather than
producing a broken asset. Re-export with relative paths and re-upload.

## Configuration

See `app.miris.upload.*` in the [Configuration Reference](../deployment/configuration-reference.md), and the [Miris Spatial Streaming Integration](../developer/external-integrations/miris-spatial-streaming.md) guide for the end-to-end viewer and upload setup.

## Requirements

-   `app.miris.enabled` must be true (the viewer that renders the pipeline's output requires it).
-   `app.webUi.allowUnsafeEvalFeatures` must be true (required by the Miris viewer's CSP gate).
-   Miris Integration Key stored in Secrets Manager; ARN in `app.miris.upload.apiKeySecretArn`.
-   Cannot be enabled in GovCloud or air-gapped deployments.
