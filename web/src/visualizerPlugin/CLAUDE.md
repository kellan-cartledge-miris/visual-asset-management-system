# CLAUDE.md - VAMS Viewer Plugin System

Auto-loaded when working within `web/src/visualizerPlugin/`. See `web/CLAUDE.md` for the frontend-wide steering.

---

## Architecture

The 3D/media viewer system uses a plugin-based architecture:

-   **PluginRegistry** (`core/PluginRegistry.ts`) — Singleton that manages all viewer plugins
-   **viewerConfig.json** (`config/viewerConfig.json`) — JSON configuration for all plugins
-   **manifest.ts** (`viewers/manifest.ts`) — Vite static-analysis paths for dynamic imports
-   **StylesheetManager** (`core/StylesheetManager.ts`) — Per-plugin CSS lifecycle management
-   **types.ts** (`core/types.ts`) — Shared `ViewerPluginProps` and config interfaces

Viewer plugins live under `viewers/{Name}ViewerPlugin/` — each plugin ID below maps to a directory of that form (e.g. `potree-viewer` → `viewers/PotreeViewerPlugin/`). Per-viewer custom-install scripts live in `web/customInstalls/` (one dir per viewer, plus a shared `utility/` helper dir) and are executed by the `postinstall` chain in `web/package.json`.

---

## Current Viewers

| ID                                 | Name                           | Category | Extensions                                                                                                                               | Status                                              |
| ---------------------------------- | ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `online3d-viewer`                  | Online 3D Viewer               | 3d       | .3dm, .amf, .bim, .off, .wrl                                                                                                             | enabled                                             |
| `potree-viewer`                    | Potree Viewer                  | 3d       | .e57, .las, .laz, .ply                                                                                                                   | enabled                                             |
| `image-viewer`                     | Image Viewer                   | media    | .png, .jpg, .jpeg, .svg, .gif                                                                                                            | enabled                                             |
| `html-viewer`                      | HTML Viewer                    | document | .html                                                                                                                                    | enabled                                             |
| `video-viewer`                     | Video Player                   | media    | .mp4, .webm, .mov, .mkv, .m4v                                                                                                            | enabled                                             |
| `audio-viewer`                     | Audio Player                   | media    | .mp3, .wav, .ogg, .aac, .flac, .m4a                                                                                                      | enabled                                             |
| `columnar-viewer`                  | Columnar Data Viewer           | data     | .fcs, .csv                                                                                                                               | enabled                                             |
| `pdf-viewer`                       | PDF Viewer                     | document | .pdf                                                                                                                                     | enabled                                             |
| `cesium-viewer`                    | Cesium 3D Tileset              | 3d       | .json                                                                                                                                    | enabled                                             |
| `text-viewer`                      | Text Viewer                    | document | .txt, .json, .xml, .html, .yaml, .md, .py, .js, .ts, .sql, etc.                                                                          | enabled                                             |
| `gaussian-splat-viewer-babylonjs`  | BabylonJS Gaussian Splat       | 3d       | .ply, .spz                                                                                                                               | enabled                                             |
| `supersplat-viewer`                | SuperSplat Editor (PlayCanvas) | 3d       | .lcc, .ply, .sog, .splat                                                                                                                 | enabled (requires ALLOWUNSAFEEVAL, iframe-embedded) |
| `gaussian-splat-viewer-playcanvas` | PlayCanvas Gaussian Splat      | 3d       | .ply, .sog                                                                                                                               | enabled                                             |
| `vntana-viewer`                    | VNTANA 3D Viewer               | 3d       | .glb                                                                                                                                     | **disabled** (licensed)                             |
| `veerum-viewer`                    | VEERUM 3D Viewer               | 3d       | .e57, .las, .laz, .ply, .json                                                                                                            | **disabled** (licensed)                             |
| `needletools-usd-viewer`           | Needle USD Viewer              | 3d       | .usd, .usda, .usdc, .usdz                                                                                                                | enabled (requires ALLOWUNSAFEEVAL)                  |
| `miris-stream-viewer`              | Miris Spatial Streaming        | 3d       | .usd, .usda, .usdc, .usdz                                                                                                                | enabled (requires MIRIS_STREAMING, ALLOWUNSAFEEVAL) |
| `threejs-viewer`                   | Three.js Viewer                | 3d       | .gltf, .glb, .obj, .fbx, .stl, .ply, .dae, .3ds, .3mf, .stp, .step, .iges, .igs, .brep                                                   | enabled                                             |
| `physna-viewer`                    | Physna Viewer                  | 3d       | .3ds, .asm, .catpart, .catproduct, .glb, .iam, .iges, .igs, .ipt, .jt, .obj, .par, .prt, .sldasm, .sldprt, .stl, .step, .stp, .x_b, .x_t | enabled (requires PHYSNA_ADDON)                     |
| `thatopenwebifc-viewer`            | ThatOpen IFC BIM Viewer        | 3d       | .ifc, .ifczip                                                                                                                            | enabled (requires ALLOWUNSAFEEVAL)                  |
| `preview-viewer`                   | Preview Viewer                 | preview  | \* (wildcard)                                                                                                                            | enabled                                             |

> Note: `miris-stream-viewer` requires the `MIRIS_STREAMING` and `ALLOWUNSAFEEVAL` feature flags and is the only entry with `autoSelect: true`, so at priority 0 it opens USD files without the chooser. On each open it calls the stream status route (`GET database/{databaseId}/assets/{assetId}/miris/asset-status`) and acts on `state`: `notStreamed` shows guidance that points to the **Needle USD Viewer (Experimental)** and to the **Miris Spatial Streaming Upload** workflow; `invalidUuid`, `notBound` (the Miris asset lacks the `vams-asset-{assetId}` or `vams-database-{databaseId}` tag) and a Miris failure show an error; `streamable` and `unknown` stream; any other state (such as `preview`) shows the processing overlay and polls every 90 seconds. Every error overlay has a **Retry** button that re-runs the load. With `MIRIS_PER_VIEW_KEYS` (`app.miris.viewerKeyMode: "perView"`) the viewer then calls `mintMirisViewerKey` (`POST .../miris/viewer-key`), reads `notBound` from a 403 body, and holds the returned key in component state for that open only (never `appCache`, storage, or logs). Otherwise it streams with the shared `mirisViewerKey` from `/secure-config`, which `Auth.tsx` replaces on every fetch and drops when the response carries none or the per-view flag is set. A file version switch does not re-mint.

> The viewer renders the `@miris-inc/components` custom elements (`<miris-scene viewer-key camera-fit="contain">`, `<miris-camera controls>`, `<miris-stream uuid>`); importing the package registers five (`<miris-group>` and `<miris-grid>` as well). The viewerConfig entry has no `dependencyManagerMethod`: the component calls `MirisStreamDependencyManager.loadMirisStream()` itself, only after the status check and key, bounded by a 60-second timeout that shows the load-failed error and abandons the pending load. Without a WebGPU adapter (`useWebGPU()` from `@miris-inc/three`) the loader sets `Miris.tryUseShark = false`, so the SDK uses its WebGL 2 engine; `isDeviceSupported()` is WebGPU or a WebGL 2 context, and a device with neither gets the unsupported-device error with no scene. GES assets need WebGPU: on the WebGL 2 engine the SDK renders its own notice inside the scene, which `.container { color: #fff }` keeps legible. The scene mounts only once the key exists, and a new key mounts a new scene through its React `key`. Auth and CSP failures fire no SDK event, so a 60-second timeout cleared by `streamloaded` is their signal, and the scene's `error` event (a WebGL shader failure) shows the unsupported-device error. React 18 does not wire custom-element events, writes `controls={false}` as present, and does not map `className`: listeners attach through `ref` in `useLayoutEffect`, `controls` is never `false`, and a `.container > miris-scene` rule sizes the scene. The three packages are pinned to one exact build and upgraded together with `three`; they ship their own types, loaded with `import type {} from "@miris-inc/components/react"`, and `skipLibCheck` stays on because those declarations import files the packages do not publish.

> `supersplat-viewer` is an **iframe-embedded** viewer — it self-hosts a from-source SuperSplat build under `public/viewers/supersplat/` and loads files via a presigned URL `?load=` parameter (see "A Framed Viewer Must Not Receive a Signed URL in the Query String" below before copying that pattern). The build is WebGPU-only (no WebGL2 fallback). Under the production CSP its `<base>` element, inline script, and embedded `pc-icon` data-URI font are blocked without breaking the editor.

---

## Adding a New Viewer Plugin

**Step 1:** Create the viewer directory:

```
viewers/MyViewerPlugin/
  MyViewerComponent.tsx     # The React component
  dependencies.ts           # Optional: dependency loader
  MyViewer.module.css       # Optional: scoped styles
```

**Step 2:** Create the component implementing `ViewerPluginProps`:

```tsx
/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from "react";
import { ViewerPluginProps } from "../../core/types";

const MyViewerComponent: React.FC<ViewerPluginProps> = ({
    assetId,
    databaseId,
    assetKey,
    versionId,
    assetVersionId,
    viewerMode,
    customParameters,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // Initialize viewer for assetKey at assetVersionId when set, else at versionId
        return () => {
            // Cleanup on unmount
        };
    }, [assetId, databaseId, assetKey, versionId, assetVersionId]);

    return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
};

export default MyViewerComponent;
```

`ViewerPluginProps` (`core/types.ts`) is the whole contract a viewer receives. A single file arrives as `assetKey` and `versionId`; a multi-file selection arrives as `multiFileKeys`, with each file's owning asset and database in `multiFiles` (build each file's URL from its own entry, falling back to the top-level `assetId` and `databaseId`). `assetVersionId`, when set, is the asset version to read files from. `viewerMode` is the host's display mode (`"collapse"` when the file page or the file-viewer modal opens, then `"wide"` or `"fullscreen"`); the host's footer controls request a change through `onViewerModeChange`, and the host decides the resulting mode. `customParameters` is the entry's `customParameters` object from `viewerConfig.json`. When `ViewerPluginProps` changes, update the interface listings in `README.md` and `documentation/docusaurus-site/docs/developer/viewer-plugins.md`.

**Step 3:** Add to `viewers/manifest.ts`:

```typescript
export const VIEWER_COMPONENTS = {
    // ... existing entries
    "./viewers/MyViewerPlugin/MyViewerComponent": "MyViewerPlugin/MyViewerComponent",
};
```

**Step 4:** Add to `config/viewerConfig.json`:

```json
{
    "id": "my-viewer",
    "name": "My Viewer",
    "description": "Description of the viewer",
    "componentPath": "./viewers/MyViewerPlugin/MyViewerComponent",
    "supportedExtensions": [".xyz"],
    "supportsMultiFile": false,
    "canFullscreen": true,
    "priority": 1,
    "dependencies": [],
    "loadStrategy": "lazy",
    "category": "3d",
    "enabled": true
}
```

**Step 5:** If the viewer has external dependencies, create a custom install script in `web/customInstalls/myviewer/` and add it to the `postinstall` chain in `web/package.json`.

---

## Plugin Config Fields

| Field                        | Type              | Description                                          |
| ---------------------------- | ----------------- | ---------------------------------------------------- |
| `id`                         | string            | Unique plugin identifier                             |
| `componentPath`              | string            | Path for manifest lookup                             |
| `dependencyManager`          | string?           | Path to dependency loader module                     |
| `dependencyManagerClass`     | string?           | Class name in dependency module                      |
| `dependencyManagerMethod`    | string?           | Load method name                                     |
| `dependencyCleanupMethod`    | string?           | Cleanup method name                                  |
| `supportedExtensions`        | string[]          | File extensions this viewer handles                  |
| `supportsMultiFile`          | boolean           | Can handle multiple files at once                    |
| `canFullscreen`              | boolean           | Supports fullscreen mode                             |
| `priority`                   | number            | Lower = listed first when multiple viewers match     |
| `autoSelect`                 | boolean?          | Open automatically as the unique top-priority match  |
| `loadStrategy`               | "lazy" \| "eager" | When to load the component                           |
| `category`                   | string            | Viewer category (3d, media, document, data, preview) |
| `featuresEnabledRestriction` | string[]?         | Required feature flags                               |
| `isPreviewViewer`            | boolean?          | True for the preview-only viewer                     |
| `enabled`                    | boolean           | Whether the plugin is active                         |
| `customParameters`           | object?           | Viewer-specific configuration                        |

---

## CSP / `unsafe-eval`

Some viewers require the `ALLOWUNSAFEEVAL` feature flag because their loaders (WASM or JIT) use `eval`. Four carry the gate in `viewerConfig.json` (`featuresEnabledRestriction: ["ALLOWUNSAFEEVAL"]`), so the registry does not offer them at all when the deployment has not enabled `allowUnsafeEvalFeatures`:

-   Needle USD Viewer
-   Miris Spatial Streaming
-   SuperSplat Editor (also iframe-embedded)
-   ThatOpen IFC BIM Viewer (web-ifc)

The **Three.js viewer is deliberately not gated**: its mesh formats (.glb, .obj, .stl, …) need no `eval`, and gating the whole plugin would remove them too. Only its OCCT CAD path (.stp/.step/.iges/.igs/.brep) has the heavier requirements, and `loadFile()` in `ThreeJSViewerPlugin/utils/fileLoaders.ts` reports them as a message on the file rather than hiding the viewer — it checks for `SharedArrayBuffer` (the COI headers) and for the OCCT bundle before loading.

`cesium-viewer` is not gated either. The viewer builds a `CesiumWidget` from the widget-less `@cesium/engine` (`CesiumViewerComponent.tsx`), which drops the `@cesium/widgets` Knockout layer whose `new Function` binding compiler was what required `unsafe-eval`; `'wasm-unsafe-eval'` in the base CSP covers what remains. See `web/customInstalls/cesium/README.md` for the build. KTX2/Basis textures and `.spz` splats are the known content types that still need the broader directive.

When adding a viewer that needs `eval`, add the feature-flag gate and update the deployment configuration reference in `documentation/docusaurus-site/docs/deployment/configuration-reference.md`.

---

## A Framed Viewer Must Not Receive a Signed URL in the Query String

A presigned Amazon S3 URL is a bearer credential: anyone holding it can read the object until it
expires. Putting one in an iframe's **query string** writes it into CloudFront or ALB access logs, which
are not treated as containing credentials and stay in the web app access-logs bucket until its
lifecycle rule removes them (`WebAppAccessLogsBucket` in `staticWebBuilder-nestedStack.ts`): the bucket
is versioned, so a log object expires after 30 days and its noncurrent version is deleted 30 days later.

`supersplat-viewer` currently does this (`SuperSplatViewerComponent.tsx` builds
`?load=<presigned>&filename=…`) — one object, expiring, but logged. **Do not copy the pattern into a new
viewer.** Use the **URL fragment** instead: browsers do not transmit a fragment, so nothing reaches the
server or its logs.

For a vendored build that reads `location.search` and cannot be changed at the call site, inject a shim
into its `index.html` from that viewer's `customInstalls/` script which moves the fragment into the query
string with `history.replaceState` before the bundle runs. Write the shim as a file beside `index.html`
and load it with a classic `<script src>` placed ahead of the bundle's: the CSP's `script-src` admits an
inline script only by the hashes of `web/index.html`'s own blocks (`cspInlineScriptHashes.ts`), so an
inline shim in a viewer page never runs. Patch the HTML entry rather than the minified bundle: the bundle
is regenerated from a pinned upstream tag on every `npm install`, so a regex against its internals breaks
on the next version bump while injected elements do not.

The shimmed page also needs `<meta name="referrer" content="no-referrer">` at the top of its `<head>`,
ahead of the shim and of every `<script>` and `<link>`. `replaceState` issues no request, but it
changes the document URL, and the browser builds the `Referer` of every later request the page makes
from that URL. The CloudFront distribution sends `Referrer-Policy: strict-origin-when-cross-origin`
(`cloudfront-s3-website-construct.ts`) and the ALB sends none, so the browser default applies, which is
the same policy. Both put the full URL, query string included, in the `Referer` of a same-origin request,
and a vendored viewer keeps fetching its own files after it starts (SuperSplat loads `static/locales/`
and `static/lib/webp/webp.wasm` from `/viewers/supersplat/`). Without the `<meta>`, each of those requests
carries the presigned URL into the web access logs: CloudFront standard logs record the `Referer`, and on
the ALB path so do the web bucket's S3 server access logs. A `<meta>` referrer policy replaces the
response header's for the requests the document makes after the element is parsed, which is why it goes
at the top, and it is the only control that covers both distributions, because the ALB cannot add a
`Referrer-Policy` header. The iframe's `referrerPolicy` attribute, which `HTMLViewerComponent.tsx` sets,
is not a substitute: it governs only the request that loads the framed page, not the requests that page
makes. A viewer that reads `location.hash` itself needs none of this, because a `Referer` never carries
the fragment.

Note the encoding interaction if you move an existing viewer: SuperSplat decodes `load` **twice**, so its
value is deliberately double-encoded (see the comment in `SuperSplatViewerComponent.tsx`). Moving the
same string to a fragment must preserve that double encoding byte-for-byte, or the presigned signature
breaks and S3 returns 400.
