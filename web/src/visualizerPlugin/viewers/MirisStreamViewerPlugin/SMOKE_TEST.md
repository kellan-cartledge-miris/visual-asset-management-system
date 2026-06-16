# Miris Viewer — Phase 1 Manual Smoke Test

Run once against a real Miris account before merging this branch. Unit tests cover the parser and component lifecycle with mocked SDK; this checklist is the only verification of the live `*.miris.com` streaming path.

## Prerequisites

- A Miris account with at least one uploaded asset (recommend a small USD or GLB).
- A valid Miris viewer key (16+ chars). Generate via the Miris Portal or `miris viewerkey create`.
- A VAMS dev stack you can deploy to (commercial region — GovCloud is blocked by `getConfig()`).
- Browser DevTools handy for the Network → WS tab.

## Steps

### 1. Deploy with Miris enabled

In `infra/config/config.json` (or your deployment-specific config), set:

```json
"miris": {
    "enabled": true,
    "viewerKey": "<your-real-miris-viewer-key>"
}
```

Deploy:

```bash
cd infra && npx cdk deploy --all --require-approval never
```

Wait for the stack update to complete.

### 2. Confirm the feature flag and viewer key propagated

Hit the deployed `/secure-config` endpoint directly (you'll need your auth token):

```bash
curl -H "Authorization: <token>" https://<vams-host>/secure-config
```

Expected response includes:
- `"featuresEnabled": "...,MIRIS_STREAMING,..."` (somewhere in the comma-separated list)
- `"mirisViewerKey": "<your-real-miris-viewer-key>"` (verbatim)

### 3. Create and upload a `.mrx` file

Locally, create `smoke-test.mrx`:

```json
{
    "schemaVersion": 1,
    "mirisAssetUuid": "<your-known-good-miris-asset-uuid>",
    "displayName": "Phase 1 Smoke Test"
}
```

Upload to an existing VAMS asset, either through the web UI or:

```bash
vamscli asset upload ./smoke-test.mrx --asset-id <existing-asset-id> --database-id <database-id>
```

### 4. Open the file in the VAMS web UI

Navigate to the asset, click `smoke-test.mrx`. Verify:

- [ ] The Miris viewer loads (no other viewer is offered for `.mrx`).
- [ ] 3D content begins to stream within a few seconds.
- [ ] Drag-to-rotate works smoothly.
- [ ] Fullscreen toggle works (button in the viewer toolbar).
- [ ] The `displayName` from the manifest appears as the viewer title.

### 5. Verify clean teardown on viewer switch

In DevTools → Network → WS, note the open WebSocket to `*.miris.com`. Navigate away to another file in the same asset. Verify:

- [ ] WebSocket transitions from "Pending" to "Closed" within ~1 second.
- [ ] Console shows no "Miris viewer load failed" errors related to the teardown.

### 6. Verify the disable path

Redeploy with `app.miris.enabled: false`:

```json
"miris": {
    "enabled": false,
    "viewerKey": "UNDEFINED"
}
```

```bash
cd infra && npx cdk deploy --all --require-approval never
```

Reload the web UI. Open the same `.mrx` file. Verify:

- [ ] The Miris viewer no longer appears in the viewer selector.
- [ ] The fallback Preview viewer takes over (or shows "no viewer available").
- [ ] `/secure-config` no longer includes `mirisViewerKey`.

### 7. Verify the malformed-manifest error path

With Miris enabled again, upload a deliberately broken `.mrx`:

```json
{ "schemaVersion": 1, "mirisAssetUuid": "not-a-uuid" }
```

Open the file. Verify:

- [ ] An error overlay shows: "This .mrx file is malformed: mirisAssetUuid is not a valid UUID."

## Sign-off

When all checkboxes pass, mark the smoke test complete in the PR description and the branch is ready to merge.
