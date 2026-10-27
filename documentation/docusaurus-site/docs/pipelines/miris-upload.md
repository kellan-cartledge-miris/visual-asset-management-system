# Miris Auto-Upload Pipeline

The Miris Auto-Upload pipeline uploads supported USD source assets to Miris Spatial Streaming and records the resulting Miris asset as [stream metadata](../developer/external-integrations/miris-spatial-streaming.md#stream-metadata) on the asset's root USD file. Once the asset is on Miris, users can stream it from the VAMS viewer by opening that file.

## When it fires

The pipeline auto-registers as a GLOBAL VAMS workflow (`miris-upload`) with a `fileUpload` trigger, and runs in two ways:

-   **Automatically**: when a file with a supported extension is uploaded to a VAMS asset, provided `app.miris.upload.autoRegisterAutoTriggerOnFileUpload` is enabled. The trigger is GLOBAL, so it fires for uploads in any database; restricting it to specific databases is a matter of registering a database-scoped copy of the workflow instead of relying on the global one.
-   **On demand**: select one of the asset's USD files in the file manager and choose **Automation -> Execute Workflow**, then pick the **Miris Spatial Streaming Upload** workflow and its **Stream with Miris** template. See [Viewer Plugins Reference](../additional/viewer-plugins.md#miris-spatial-streaming-viewer).

Either way, the workflow takes exactly one file: selecting the whole asset (`/`) blocks **Continue** in the execute wizard with "Workflow does not allow whole-asset ('/') selection", and folders are rejected for the same reason. The file only names the asset. The pipeline uploads the asset's [root USD file](#how-the-root-is-chosen), whichever of its USD files started the run, and records the stream metadata on that root file.

### Duplicate uploads and re-runs

A `fileUpload` trigger fires once per matching file, so an asset made of several USD layers fans out to one execution per layer. The upload gate collapses that fan-out with a claim, a conditional Amazon S3 put in the auxiliary bucket:

```text
s3://<auxiliary-bucket>/locks/miris-upload/<assetId>/<fingerprint>.claim
```

The fingerprint is a SHA-256 digest of the asset-relative path and ETag of every file under the asset's root whose extension is one of `app.miris.upload.triggerExtensions`. Executions fanned out from one upload compute the same fingerprint once all of its USD files are in place, so the first to write the claim proceeds and the others report `skipped` and exit without a Batch job.

-   **Unchanged USD files.** A successful upload keeps its claim, so a later trigger on the same USD content reports `skipped`.
-   **Changed, added, or reverted USD files.** Any change to a USD layer's path or content gives a new fingerprint, so the next trigger uploads again. A successful upload also deletes the asset's claims on other content, so returning to earlier content uploads again too.
-   **Failed runs.** A run that does not succeed releases its claim, so the next trigger on the same content uploads.
-   **Manual runs.** **Stream with Miris** from **Automation -> Execute Workflow** always uploads and writes no claim. When it succeeds it deletes the asset's existing claims, so the next trigger uploads again. No claim object ever needs to be deleted by hand.

### Known limitations

-   **Non-USD files do not re-trigger an upload.** Only files with a trigger extension enter the fingerprint. A change to textures or other files that leaves every USD file unchanged gives the same fingerprint, so the trigger reports `skipped`. Run **Stream with Miris** on the asset to upload the change.
-   **A queued run uploads the asset as it is when its job starts.** The container lists and downloads the asset when its AWS Batch job starts, not when the gate fingerprinted it. When newer files land while a run waits in the job queue, that run can upload the newer content under the earlier claim. The next trigger corrects the stream; so does running **Stream with Miris**.
-   **A multi-file upload can upload twice.** Each uploaded file starts its own execution. A gate that runs before every USD file of the upload has landed computes a different fingerprint from the later ones, so that run uploads as well.

## Viewing the result

After upload, Miris processes the asset (typically 1–2 hours) before it becomes streamable. Once the pipeline has written the stream metadata, opening the root USD file shows the Miris viewer, which displays a "preparing" overlay until the asset is ready and then streams it. See [Viewer plugin](../developer/external-integrations/miris-spatial-streaming.md#viewer-plugin) for the viewer's states and the banner it shows when the file has changed since it was streamed.

## What the pipeline writes

The pipeline adds no files to the asset. It writes one `.metadata.json` file to the run's metadata output path, at `{outputS3AssetMetadataPath}<relativeFilePath>.metadata.json`, where `<relativeFilePath>` is the root USD file's path within the asset (for example `scenes/pump.usda`). The path is taken relative to the asset's root, so it is correct for buckets with a `baseAssetsPrefix` and for assets created on an existing bucket folder (`bucketExistingKey`). The workflow's process-output step applies it to that file as `SYSTEM_USER` with `updateType: update`, so the file's other metadata keys are kept. The file carries the four stream metadata keys described in [Stream metadata](../developer/external-integrations/miris-spatial-streaming.md#stream-metadata): the Miris asset UUID, the Amazon S3 version ID of the USD object the container downloaded, the upload completion time, and the Miris asset name.

When the run's metadata output path is missing, the pipeline fails before it submits the AWS Batch job, so nothing is uploaded to Miris without a place to record the result.

-   **Re-running.** Running **Stream with Miris** again, or a trigger on changed USD content, uploads a new Miris asset and overwrites the four keys with it. The previous Miris asset is not deleted; remove it in the Miris Portal if it is no longer needed.
-   **Output path extension.** The metadata file is applied to the path it is written at, relative to the run's output folder. The registered `miris-upload` workflow uses the default output path extension (`/`). A custom workflow that runs this pipeline with a `defaultOutputFileBaseExecutionPathExtension` (see [Pipelines and workflows](../concepts/pipelines-and-workflows.md)) shifts the path the metadata is applied to, so the keys do not land on the source USD file.

## Supported source formats

`.usd`, `.usda`, `.usdc`, `.usdz`. The Miris content API accepts one file per asset, so the pipeline packages a multi-file USD asset into a single `.usdz` before upload (see [Multi-file USD assets](#multi-file-usd-assets)).

## What the container does

The container lists the asset under its resolved root, which carries the bucket's `baseAssetsPrefix` or the asset's existing-key location, and [chooses the root USD file](#how-the-root-is-chosen). It checks `app.miris.upload.maxAssetSizeBytes` against the sizes in that listing before it downloads anything: a lone `.usdz` root counts alone, and otherwise every file under the asset root counts. It then downloads what it needs, packages a multi-file root, and runs the Miris upload:

1. `POST /v1/content` starts the upload and returns a Miris asset ID and short-lived upload credentials.
2. A SigV4-signed `PUT` sends the file to the Miris upload storage.
3. `PUT /v1/content/{id}` with `{"status": "completed"}` marks the upload complete.
4. `GET /v1/asset/{id}` is polled until the asset's state is `preview` or `streamable`, for at most `app.miris.upload.taskTimeoutSeconds`.
5. `POST /v1/asset/{id}/generate` requests streamable processing. This step is best effort: when it fails, the asset can be promoted in the Miris Portal.
6. The stream metadata file for the root USD file is written to the run's metadata output path (see [What the pipeline writes](#what-the-pipeline-writes)).

The container retries its idempotent Miris calls (`GET`, `PUT`, and `DELETE`) with backoff after a transient request failure or a `429`, `500`, `502`, `503`, or `504` response, and never retries the request that creates the asset. When a step fails after the Miris asset exists, the container deletes that asset, best effort, and logs its ID. The container runs as a non-root user.

### Miris asset name and tags

The **Stream with Miris** template has two optional fields. `MIRIS_ASSET_NAME` names the Miris asset; blank uses the VAMS asset name. `MIRIS_TAGS` lists tags to add to it. The rendered configuration also carries `triggerType`, which tells the pipeline whether a user launched the run (`Manual`) or a file upload triggered it.

Every Miris asset the pipeline creates carries the tags `vams`, `vams-asset-{assetId}`, and `vams-database-{databaseId}`; the last two are the [binding tags](../developer/external-integrations/miris-spatial-streaming.md#binding-tags) that `perView` mode checks. A configured tag that begins with `vams-asset-` or `vams-database-`, compared without regard to case, is dropped with a warning in the container log, because it could bind the Miris asset to another VAMS asset.

## Time limits

-   **Miris processing wait.** `app.miris.upload.taskTimeoutSeconds` (default 1800) bounds step 4. When Miris does not report `preview` or `streamable` in time, the run fails.
-   **AWS Batch job.** Each job attempt may run for `taskTimeoutSeconds` plus 1,200 seconds, which covers the download, packaging, upload, and metadata write.
-   **Inner state machine.** The pipeline's AWS Step Functions state machine times out 1,800 seconds after the Batch attempt limit, which leaves time for the job queue and the pipeline's Lambda functions.
-   **Workflow task.** The calling workflow waits up to 172,800 seconds (48 hours) for the pipeline's callback (`executionConfig.taskTimeout` in the pipeline's `vamsSchema/pipeline.json`). It is not derived from `taskTimeoutSeconds`.

When the inner execution times out, is stopped, or fails without reaching its own failure step, an Amazon EventBridge rule on its status change invokes the pipeline's end Lambda, which releases the upload claim and fails the workflow task with a reason, so the workflow does not wait out its 48 hours.

## Failure reasons

A failed run reports one of these reasons to the workflow execution, chosen from the container's exit code:

| Exit code | Reason                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1         | The container failed with an unexpected error. See the container log.                                                            |
| 2         | The container was started without a complete pipeline definition.                                                                |
| 3         | The file is not a USD format the pipeline accepts (`.usd`, `.usda`, `.usdc` or `.usdz`).                                         |
| 4         | The asset is larger than `app.miris.upload.maxAssetSizeBytes`.                                                                   |
| 5         | The USD file references layers or assets that are not part of the VAMS asset.                                                    |
| 6         | The asset has no USD file to upload, or every USD file in it is referenced by another.                                           |
| 7         | The run has no metadata output location for the stream metadata.                                                                 |
| 8         | Miris rejected the upload or could not process it. See the container log.                                                        |
| 9         | Miris did not finish processing the asset within `app.miris.upload.taskTimeoutSeconds`.                                          |
| 10        | The asset has more than one root USD file (`ambiguous_root`): no other USD file in the asset references them.                    |
| 11        | A USD file in the asset is empty or malformed (`unreadable_layer`). The container log's `unreadable_layer` entry names the file. |

A Batch job stopped at its time limit, an inner execution that timed out or was stopped, and a failure in one of the pipeline's Lambda functions each report their own reason. The container log is in the `/aws/vendedlogs/Pipelines/MirisUpload<hash>` log group.

## How the root is chosen

The root is the one file, among the asset's files with a trigger extension, that no other USD layer in the asset references through a sublayer, reference, payload, value clip, or asset-valued attribute. An asset with a single `.usdz` and no other USD layer uses that `.usdz`.

-   More than one candidate root fails the run with `ambiguous_root` (exit code 10), and the container log lists the candidates. Keep one root layer per asset, or reference the other layers from it.
-   A USD layer that cannot be read, because it is empty or malformed, fails the run with `unreadable_layer` (exit code 11), and the container log names the file.
-   An asset whose USD files all reference one another has no root and fails with exit code 6.

## Multi-file USD assets

A root `.usd`, `.usda`, or `.usdc` that references external files, such as textures and sublayers, is packaged into a single `.usdz` inside the pipeline container before upload, because the Miris content API accepts one self-contained file per asset. Dependency discovery uses OpenUSD's `UsdUtils.ComputeAllDependencies`, so only referenced files are included and incidental files such as `.DS_Store` are left out. A root `.usd`, `.usda`, or `.usdc` file with no external references is uploaded as is, and a `.usdz` root is passed through unchanged.

**References must be relative.** A reference to an absolute path, such as `/Users/designer/textures/wood.png`, cannot be resolved, so the run fails with an `unresolved_references` log entry and exit code 5 instead of producing a broken asset. Re-export the asset with relative paths and upload it again.

## Configuration

See `app.miris.upload.*`, `app.miris.apiKeySecretArn`, and `app.miris.mirisApiBaseUrl` in the [Configuration Reference](../deployment/configuration-reference.md), and the [Miris Spatial Streaming Integration](../developer/external-integrations/miris-spatial-streaming.md) guide for the end-to-end viewer and upload setup.

## Requirements

-   `app.miris.enabled` must be true (the viewer that renders the pipeline's output requires it).
-   `app.webUi.allowUnsafeEvalFeatures` must be true (required by the Miris viewer's CSP gate).
-   The Miris Integration Key is stored in AWS Secrets Manager, and `app.miris.apiKeySecretArn` holds the secret's complete ARN.
-   `app.useGlobalVpc.enabled` must be true. The AWS Batch jobs run in private subnets and reach Miris over the internet through the NAT gateway; an imported VPC needs `optionalExternalPrivateSubnetIds` with a route to the internet.
-   Cannot be enabled when `app.govCloud.enabled` is `true`, which the restricted partitions (AWS GovCloud (US), AWS European Sovereign Cloud, and the ISO partitions) require.
