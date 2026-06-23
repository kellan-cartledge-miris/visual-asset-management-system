# Miris Auto-Upload Pipeline

The Miris Auto-Upload pipeline streams supported source assets into the Miris Spatial Streaming platform and emits a `.mrx` manifest back to the asset's file list. Users can then open the `.mrx` to view the asset via the Miris Spatial Streaming viewer (Phase 1).

## When it fires

The pipeline auto-triggers when a file with a supported extension is uploaded to a VAMS asset in a database listed in `app.miris.upload.enabledDatabaseIds`. A user can also trigger it manually by clicking the "Stream with Miris" button on an asset detail page.

## Supported source formats

`.usd`, `.usda`, `.usdc`, `.usdz`. Multi-file USD assets must be `.usdz` packaged — the Miris content API accepts only one file per upload.

## What the container does

1. POST /v1/asset to start the upload, get a Miris asset ID and short-lived S3 STS credentials.
2. SigV4-signed PUT to the Miris temp S3 endpoint.
3. PUT /v1/asset/upload/{id} `{status: "completed"}` to mark upload complete.
4. POST /v1/asset/{id}/generate to trigger streamable processing.
5. Poll GET /v1/asset/{id} until the state field indicates streamable-ready.
6. Write a `.mrx` manifest with `mirisAssetUuid = <id>` to the asset's output files path.

## Configuration

See `app.miris.upload.*` in the [Configuration Reference](../deployment/configuration-reference.md).

## Requirements

- `app.miris.enabled` must be true (the viewer plumbing the pipeline produces output for).
- `app.webUi.allowUnsafeEvalFeatures` must be true (inherited Phase 1 gate).
- Miris Integration Key stored in Secrets Manager; ARN in `app.miris.upload.apiKeySecretArn`.
- Cannot be enabled in GovCloud or air-gapped deployments.
