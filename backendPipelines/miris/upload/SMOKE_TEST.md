# Miris Upload Pipeline — Manual Smoke Test

Run once against a real Miris account before merging changes to this pipeline.

## Prerequisites

-   The Miris viewer (`app.miris.enabled` + `app.miris.viewerKey`) deployed and working (smoke-tested per its own checklist).
-   A Miris account with a valid Integration Key stored as a Secrets Manager
    plaintext secret. Capture the ARN.
-   `app.miris.upload.enabled: true` and `apiKeySecretArn` pointing at that ARN.
-   `app.webUi.allowUnsafeEvalFeatures: true` (inherited gate).
-   A known good `.usdz` file, and a multi-file USD asset (a root `.usda` plus
    at least one additional standalone `.usd`/`.usda`/`.usdc` layer as a
    sibling file, not referenced via sublayer/reference) you can upload to VAMS.

## Steps

### 1. Deploy

```bash
cd infra && AWS_PROFILE=<your-profile> npx cdk deploy --all --require-approval never
```

Verify CFN outputs include the new Miris upload Lambda names.

### 2. Confirm registration

```bash
vamscli pipeline get -d GLOBAL -p miris-upload --json-output
vamscli workflow get -d GLOBAL -w miris-upload --json-output
```

Both should return an active (unarchived) record, and the workflow's `fileUpload`
trigger should be enabled when `autoRegisterAutoTriggerOnFileUpload: true`.

### 3. Upload a single-file USD asset (auto-trigger path)

-   [ ] Upload `model.usdz` to a VAMS asset.
-   [ ] In Step Functions, find the new execution. Trace through: gate
        Lambda -> vamsExecuteMirisUpload -> openMirisUploadPipeline -> inner
        SFN -> Batch container.
-   [ ] Container logs (CloudWatch) show, in order: `downloaded`, `start_upload`
        (POST /v1/content), `sigv4_put_complete`, `upload_marked_complete`
        (PUT /v1/content/{id}), `terminal_state_reached` with `state=preview`
        (or already `streamable`), `generate_triggered` OR `generate_skipped`
        (best-effort streamable promotion), `manifest_written`.
-   [ ] Within `taskTimeoutSeconds`, a `model.usdz.mrx` file appears in the asset's
        file list.
-   [ ] In the Miris Portal, the asset shows up at state `preview`. If the
        best-effort `generate` call worked it will move on to `streamable` over
        the next few hours. If `generate_skipped` was logged, manually click
        "Generate streamable" in the Portal for that asset (one credit).
-   [ ] Once the Miris asset reaches `streamable`, open the `.mrx` (or the USD
        source file) in the VAMS web UI — the Miris viewer streams the asset.

### 4. Multi-file USD asset produces exactly ONE Miris upload

This is the case the claim gate exists for: a `fileUpload` trigger fires once
per uploaded file, so an asset made of several standalone `.usd` layers fans
out to one execution per layer before the gate collapses them.

-   [ ] Upload the multi-file USD asset from the prerequisites — several
        `.usd`/`.usda`/`.usdc` files landing in the same asset version, each
        independently matching the trigger's file filter.
-   [ ] In Step Functions, confirm one execution reaches the Batch container
        and every other execution triggered by the same upload reports a
        `{"status": "skipped", ...}` output and completes immediately (no
        Batch job).
-   [ ] Exactly one `.mrx` manifest is written, and the Miris Portal shows
        exactly one asset for this upload — not one per `.usd` layer.

### 5. Upload to a database not covered by the workflow

Database scope is a property of the workflow that owns the trigger, not a
pipeline-level allow-list: the auto-registered `miris-upload` workflow is
GLOBAL, so its trigger fires for uploads in every database. To test scoping,
register a database-scoped copy of the workflow (or disable the global
trigger) and confirm an upload to a database the workflow does not cover
produces no execution — no Batch job, no `.mrx`.

### 6. Manual trigger via Automation, and forcing a re-run

-   [ ] On the asset from step 3, select its root USD source file in the file
        manager and choose **Automation -> Execute Workflow**. Pick the
        **Miris Spatial Streaming Upload** workflow and the **Stream with
        Miris** template, optionally filling in the asset name / tags fields,
        and run it.
-   [ ] Selecting the whole asset (`/`) instead blocks **Continue** with
        "Workflow does not allow whole-asset ('/') selection" — the workflow
        takes exactly one file.
-   [ ] Because the asset's current version already holds a claim, this run
        reports `skipped` and does not re-upload.
-   [ ] Delete the claim object at
        `s3://<auxiliary-bucket>/locks/miris-upload/<assetId>/<currentVersionId>.claim`
        and run the workflow again from **Automation -> Execute Workflow**.
        The pipeline runs to completion and the `.mrx` is rewritten.
-   [ ] Creating a new **asset version** (the _Create Asset Version_ action)
        also re-runs the pipeline, since the claim key includes the version
        id. Re-uploading files into the same asset does **not** create an
        asset version, so it keeps the same claim key: deleting the claim
        object is the way to force a re-run after a file re-upload.
-   [ ] Force a container failure (for example with the oversize limit from
        step 8) on an asset version with no claim yet. The claim is released
        automatically, so the next Automation run for that same version starts
        a new upload rather than reporting `skipped`.

### 7. Validation gate

-   [ ] Try `cdk deploy` with `app.miris.upload.enabled: true` but
        `app.webUi.allowUnsafeEvalFeatures: false`. CDK synth rejects with
        a clear error.

### 8. Oversize file

-   [ ] Set `app.miris.upload.maxAssetSizeBytes: 1000` temporarily and
        redeploy. Upload anything larger. Container fails clean with
        `file_too_large` log entry. The outer workflow records a failure
        within seconds (the pipeline reports `SendTaskFailure`; it does not
        sit until the workflow task timeout), and the claim for that asset
        version is gone from the auxiliary bucket. Revert the config after.

### 9. Multi-file USD (textures / sublayers, single upload)

-   [ ] Upload a USD asset folder: a root `.usda` plus a `textures/` subfolder it
        references by relative path.
-   [ ] Container logs show, in order: `artifact_ready`, `packaged_usdz`
        (with `assets` >= 1), `start_upload`, `sigv4_put_complete`,
        `upload_marked_complete`, `terminal_state_reached`.
-   [ ] The Miris asset reaches `preview`/`streamable` (textures resolved).

### 10. Unresolved references (clean failure)

-   [ ] Upload a `.usda` that references an absolute texture path
        (e.g. `@/Users/.../tex.png@`).
-   [ ] Container exits non-zero; logs show `unresolved_references` with the
        offending path(s). No partial/broken asset is left streamable.

## Sign-off

When all checkboxes pass, mark the smoke test complete in the PR description.
