# Miris Stream Viewer: Manual Smoke Test

Run once against a real Miris account before merging changes to this viewer. Unit tests cover the status handling and component lifecycle with a mocked SDK and API; this checklist is the only verification of the live `*.miris.com` streaming path.

The viewer streams the Miris asset recorded in a USD file's `miris_asset_uuid` file metadata, which it reads through `GET /database/{databaseId}/assets/{assetId}/miris/asset-status?filePath=`. This checklist sets that metadata by hand, so it does not need the upload pipeline. The pipeline path is covered by `backendPipelines/miris/upload/SMOKE_TEST.md`.

## Prerequisites

-   A Miris account with at least one streamable asset, and its asset UUID. A second streamable asset UUID is needed for step 5.
-   A valid Miris viewer key (16+ chars) from the same Miris workspace as those assets. Generate one in the Miris Portal or with `miris viewerkey create`.
-   A small USD file (`.usdz` recommended) to upload to VAMS. Its geometry does not matter; the viewer streams the Miris asset, not the file.
-   A VAMS dev stack you can deploy to (commercial region; GovCloud is blocked by `getConfig()`).
-   Browser DevTools open on the Network tab (WS and Fetch/XHR filters) and the Console.
-   A browser with WebGPU (current desktop Chrome or Edge) for the default engine; step 4b also covers the WebGL 2 engine and an unsupported device.
-   The viewer renders with `@miris-inc/components`, `@miris-inc/three` and `@miris-inc/core`, all pinned to `0.0.8-540abbc` in `web/package.json`. After an SDK upgrade, confirm the three versions in `web/package-lock.json` still match.
-   Docker Desktop with the **containerd image store disabled** (Settings → General → uncheck "Use containerd for pulling and storing images"). With it enabled, CDK Lambda layer bundling fails because BuildKit-built images aren't visible to `docker run`.
-   CDK bootstrap in **two regions**: your primary region (e.g. `us-west-2`) AND `us-east-1`. The CloudFront WAF stack lives in us-east-1 regardless of where the main stack deploys.

## Steps

### 1. Deploy with Miris enabled

In `infra/config/config.json` (or your deployment-specific config), set both blocks:

```json
"webUi": {
    "allowUnsafeEvalFeatures": true
},
"miris": {
    "enabled": true,
    "viewerKey": "<your-real-miris-viewer-key>"
}
```

`allowUnsafeEvalFeatures: true` is required: `getConfig()` rejects `miris.enabled` without it. The Miris web SDK compiles code at runtime, so it lives on the same opt-in trust boundary as Cesium and Needle USD. With Miris enabled the CSP also lists `blob:` in `script-src` and `*.miris.com` in `connect-src`. The upload pipeline (`miris.upload.enabled`) is not needed for this checklist.

Bootstrap CDK in both regions if you haven't already:

```bash
npx cdk bootstrap aws://<account>/us-west-2
npx cdk bootstrap aws://<account>/us-east-1   # required for CloudFront WAF
```

Deploy:

```bash
cd infra && npx cdk deploy --all --require-approval never
```

Wait for the stack update to complete.

### 2. Confirm the feature flag, viewer key, and schema

Hit the deployed `/secure-config` endpoint directly (you'll need your auth token):

```bash
curl -H "Authorization: <token>" https://<vams-host>/secure-config
```

Expected response includes:

-   `"featuresEnabled": "...,MIRIS_STREAMING,..."` (somewhere in the comma-separated list)
-   `"mirisViewerKey": "<your-real-miris-viewer-key>"` (verbatim)

Then:

-   [ ] The metadata schema list (`vamscli metadata-schema list -d GLOBAL`) shows a `fileMetadata` schema named **Miris stream**, restricted to `.usd,.usda,.usdc,.usdz`, with the optional fields `miris_asset_uuid`, `miris_source_version_id`, `miris_uploaded_at` (date), and `miris_display_name`.

### 3. Open a USD file that has not been streamed

Upload the USD file to an existing VAMS asset, through the web UI or:

```bash
vamscli file upload -d <database-id> -a <asset-id> ./smoke-test.usdz
```

Navigate to the asset and click `smoke-test.usdz`. Verify:

-   [ ] The **Miris Spatial Streaming** viewer is selected by default, and the Needle USD Viewer is still offered in the viewer selector.
-   [ ] The viewer shows **Not yet streamed with Miris**, pointing to the file manager's **Automation** action and **Stream with Miris**.
-   [ ] The Network tab shows a `miris/asset-status?filePath=...` request returning `"state": "notStreamed"`, and no download request for the file.

### 4. Point the USD file at an existing Miris asset by hand

Open the file's metadata in the web UI. Verify:

-   [ ] The four **Miris stream** fields are listed for the USD file even though they have no values.

Set `miris_asset_uuid` to your known-good Miris asset UUID and `miris_display_name` to `Smoke Test`. Leave `miris_source_version_id` and `miris_uploaded_at` empty. The same edit from the CLI:

```bash
vamscli metadata file update -d <database-id> -a <asset-id> --file-path "/smoke-test.usdz" --type metadata \
  --json-input '{"metadata":[{"metadataKey":"miris_asset_uuid","metadataValue":"<miris-asset-uuid>","metadataValueType":"string"},{"metadataKey":"miris_display_name","metadataValue":"Smoke Test","metadataValueType":"string"}]}'
```

Reopen `smoke-test.usdz`. Verify:

-   [ ] `miris/asset-status` returns the UUID you set and `"state": "streamable"` (or `unknown`; the viewer streams in both cases).
-   [ ] 3D content begins to stream within a few seconds.
-   [ ] `Smoke Test` appears as the overlay label.
-   [ ] No "different version" banner is shown (no source version is recorded).
-   [ ] **Fill and framing:** the scene fills the viewer panel, and the asset is framed and centered in view (the `<miris-scene camera-fit="contain">` element does the framing), not at the origin inside the asset. Resizing the window or the panel keeps the asset framed.
-   [ ] **Drag to orbit:** left-click drag orbits the camera around the asset center. The asset itself stays fixed; the camera moves.
-   [ ] **Scroll to zoom:** mouse wheel / pinch zooms toward the orbit target.
-   [ ] **Right-click drag to pan:** moves the orbit target through space.
-   [ ] **Damping:** motion has a small inertial smoothing (release-and-keep-moving).
-   [ ] Fullscreen toggle works (button in the viewer toolbar).
-   [ ] The Console shows no Content Security Policy violations (in particular none for `blob:` scripts or `eval`), and no failed `*.miris.com` requests.
-   [ ] Network: the SDK's `.wasm` responses are `200` with `Content-Type: application/wasm`.

### 4b. Renderer selection and unsupported devices

-   [ ] In a WebGPU browser the stream renders with the default engine.
-   [ ] The browser console shows which engine started: `webgpu is available! initializing shark renderer` for WebGPU, `shark is turned off. initializing spork renderer` for WebGL 2. These lines come from the SDK and can change between SDK versions, so treat them as informational.
-   [ ] Reload with `?shark=0` in the real query string, before the `#` (for example `https://<vams-host>/?shark=0#/...`). The stream renders with the WebGL 2 engine, and the framing and controls from step 4 behave the same.
-   [ ] In a browser with no WebGPU adapter, the viewer selects the WebGL 2 engine on its own and streams.
-   [ ] In a browser with neither WebGPU nor WebGL 2 (for example WebGL disabled in the browser settings), opening the file shows "Miris streaming is not supported on this device" immediately, not a blank panel or a 60-second wait.

### 5. Switch and clear the stream

-   [ ] Change `miris_asset_uuid` to your second Miris asset UUID and reopen the file. The second asset streams.
-   [ ] Clear `miris_asset_uuid` (empty value) and reopen the file. The viewer shows **Not yet streamed with Miris** again.

### 6. Verify the different-version banner

Set `miris_asset_uuid` back to a streamable UUID, and set `miris_source_version_id` to the file's current S3 version ID (from `vamscli file info -d <database-id> -a <asset-id> -p "/smoke-test.usdz" --include-versions`). Reopen the file:

-   [ ] The asset streams with no banner.

Upload a new version of `smoke-test.usdz` (any change to the file) without touching its metadata, then reopen it:

-   [ ] The asset still streams, with the banner "This stream was built from a different version of this file. Run Stream with Miris again to update it."

### 7. Verify the invalid-UUID error path

Set `miris_asset_uuid` to `not-a-uuid` and reopen the file. Verify:

-   [ ] `miris/asset-status` returns `"state": "invalidUuid"`.
-   [ ] An error overlay shows: "This file's miris_asset_uuid metadata is not a valid UUID. Correct it in the file's metadata, or run Stream with Miris again."

### 8. Verify clean teardown on viewer switch

Restore a valid UUID and open the file. In DevTools → Network → WS, note the open WebSocket to `*.miris.com`. Navigate away to another file in the same asset. Verify:

-   [ ] WebSocket transitions from "Pending" to "Closed" within ~1 second.
-   [ ] Console shows no "Miris viewer load failed" errors related to the teardown.
-   [ ] Switching back to the Miris viewer in the same session loads it again.

### 9. Verify the disable path

Redeploy with `app.miris.enabled: false` (you may also revert `allowUnsafeEvalFeatures` if it was only set for Miris):

```json
"webUi": {
    "allowUnsafeEvalFeatures": false
},
"miris": {
    "enabled": false,
    "viewerKey": "UNDEFINED"
}
```

```bash
cd infra && npx cdk deploy --all --require-approval never
```

Reload the web UI. Open the same USD file. Verify:

-   [ ] The Miris viewer no longer appears in the viewer selector.
-   [ ] `/secure-config` no longer includes the viewer key.
-   [ ] The **Miris stream** schema and the file's `miris_*` metadata are still present (the schema is not removed when Miris is disabled).

### 9b. Verify the validation gate (optional)

To confirm the security gate works, try to deploy with `miris.enabled: true` but `allowUnsafeEvalFeatures: false`. `getConfig()` should reject the deployment at synth time with: `Configuration Error: app.miris.enabled requires app.webUi.allowUnsafeEvalFeatures = true...`

-   [ ] CDK synth fails with the expected error message.

## Per-view viewer keys

Run when the deployment sets `app.miris.viewerKeyMode: "perView"` (the stack then records `MIRIS_PER_VIEW_KEYS`). No shared viewer key is deployed in this mode.

-   [ ] `/secure-config` lists `MIRIS_PER_VIEW_KEYS` in `featuresEnabled` and has no `mirisViewerKey` field.
-   [ ] Opening a streamed USD file in the Miris viewer sends one `POST .../assets/{assetId}/miris/viewer-key` request with body `{"filePath": "/<object key>"}` after the `asset-status` request, and the stream renders.
-   [ ] The response carries `viewerKey`, `mirisAssetUuid` (matching the status UUID) and `expiresAt`; the key does not appear in `localStorage`, `sessionStorage` or the console.
-   [ ] Closing and reopening the viewer sends a new mint request.
-   [ ] A user without access to the asset sees "You do not have permission to stream this asset." and no stream.

## Sign-off

When all checkboxes pass, mark the smoke test complete in the PR description and the branch is ready to merge.
