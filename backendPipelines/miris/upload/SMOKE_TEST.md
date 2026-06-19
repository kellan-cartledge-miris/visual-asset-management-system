# Miris Upload Pipeline — Phase 2 Manual Smoke Test

Run once against a real Miris account before merging this branch.

## Prerequisites

- Phase 1 (viewer) deployed and working (smoke-tested per its checklist).
- A Miris account with a valid Integration Key stored as a Secrets Manager
  plaintext secret. Capture the ARN.
- `app.miris.upload.enabled: true`, `apiKeySecretArn` pointing at that ARN,
  and at least one databaseId in `enabledDatabaseIds`.
- `app.webUi.allowUnsafeEvalFeatures: true` (inherited gate).
- A known good `.usdz` file you can upload to VAMS.

## Steps

### 1. Deploy

```bash
cd infra && AWS_PROFILE=<your-profile> npx cdk deploy --all --require-approval never
```

Verify CFN outputs include the new Miris upload Lambda names.

### 2. Confirm feature flag and config

```bash
# Confirm the gate Lambda has the right env var
aws lambda get-function-configuration \
  --function-name <mirisUploadGate function name> \
  --query 'Environment.Variables.MIRIS_UPLOAD_ENABLED_DATABASES'
```

Should print the JSON array of allowed databaseIds.

### 3. Upload to an ALLOWED database (auto-trigger path)

- [ ] Upload `model.usdz` to an asset in a database listed in `enabledDatabaseIds`.
- [ ] In Step Functions, find the new execution. Trace through: gate
      Lambda → vamsExecuteMirisUpload → openMirisUploadPipeline → inner
      SFN → Batch container.
- [ ] Container logs (CloudWatch) show, in order:
      - `downloaded`
      - `start_upload`
      - `sigv4_put_complete`
      - `upload_marked_complete`
      - `generate_triggered`
      - `streamable_ready`
      - `manifest_written`
- [ ] Within `taskTimeoutSeconds`, a `model.usdz.mrx` file appears in the asset's
      file list.
- [ ] Open the `.mrx` in the VAMS web UI → Phase 1 viewer streams the asset.

### 4. Upload to a NON-allowed database

- [ ] Upload another `model.usdz` to an asset in a database NOT in
      `enabledDatabaseIds`.
- [ ] In Step Functions, the gate Lambda fires and the workflow records a
      `skipped` outcome. No Batch job. No `.mrx`.

### 5. UI button (manual trigger)

- [ ] Delete the `.mrx` from the asset in step 3.
- [ ] On the asset detail page, the "Stream with Miris" button appears.
- [ ] Click it. The button is bypassed of the gate (via `manual: true`).
- [ ] The pipeline runs again; `.mrx` reappears.

### 6. Validation gate

- [ ] Try `cdk deploy` with `app.miris.upload.enabled: true` but
      `app.webUi.allowUnsafeEvalFeatures: false`. CDK synth rejects with
      a clear error.

### 7. Oversize file

- [ ] Set `app.miris.upload.maxAssetSizeBytes: 1000` temporarily and
      redeploy. Upload anything larger. Container fails clean with
      `file_too_large` log entry. Outer workflow records failure.
      Revert the config after.

## Sign-off

When all checkboxes pass, mark the smoke test complete in the PR description.
