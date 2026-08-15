# Miris Auto-Upload Pipeline

The Miris Auto-Upload pipeline streams supported source assets into the Miris Spatial Streaming platform and emits a `.mrx` manifest back to the asset's file list. Once the asset is on Miris, users can stream it from the VAMS viewer by selecting either the generated `.mrx` manifest or the original USD source file.

## When it fires

The pipeline auto-registers as a GLOBAL VAMS workflow (`miris-upload`) with a `fileUpload` trigger, and runs in two ways:

-   **Automatically** — when a file with a supported extension is uploaded to a VAMS asset, provided `app.miris.upload.autoRegisterAutoTriggerOnFileUpload` is enabled. The trigger is GLOBAL, so it fires for uploads in any database; restricting it to specific databases is a matter of registering a database-scoped copy of the workflow instead of relying on the global one.
-   **On demand** — select the asset or its USD source file in the file manager and choose **Automation -> Execute Workflow**, then pick the **Miris Spatial Streaming Upload** workflow and its **Stream with Miris** template. See [Viewer Plugins Reference](../additional/viewer-plugins.md#miris-spatial-streaming-viewers).

Either trigger invokes the pipeline's workflow with the asset's **root USD file** as input. The pipeline requires a single source file — it does not accept a folder. A `fileUpload` trigger fires once per matching file, so a multi-file USD asset made up of several standalone USD layers can fan out to one execution per layer; the upload gate claims the asset's current version and lets only the first execution proceed, so the asset is uploaded to Miris exactly once regardless of how many files triggered it.

## Viewing the result

After upload, Miris processes the asset (typically 1–2 hours) before it becomes streamable. In the meantime the viewer shows a "preparing" overlay and refreshes automatically when the asset is ready. Selecting either the `.mrx` manifest or the USD source file opens the same Miris stream viewer.

The viewer downloads the small `.mrx` manifest to obtain the Miris asset UUID. This manifest download is permitted even when the asset is marked non-distributable, since the `.mrx` is only a streaming pointer (the geometry is hosted on Miris and is never downloaded through VAMS). Per-asset access authorization still applies.

## Supported source formats

`.usd`, `.usda`, `.usdc`, `.usdz`. Multi-file USD assets must be `.usdz` packaged — the Miris content API accepts only one file per upload.

## What the container does

1. POST /v1/asset to start the upload, get a Miris asset ID and short-lived S3 STS credentials.
2. SigV4-signed PUT to the Miris temp S3 endpoint.
3. PUT /v1/asset/upload/{id} `{status: "completed"}` to mark upload complete.
4. POST /v1/asset/{id}/generate to trigger streamable processing.
5. Poll GET /v1/asset/{id} until the state field indicates streamable-ready.
6. Write a `.mrx` manifest with `mirisAssetUuid = <id>` to the asset's output files path.

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
