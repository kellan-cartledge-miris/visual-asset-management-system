# Viewer Plugins

VAMS includes a plugin-based viewer architecture with 17 built-in viewer plugins for visualizing 3D models, point clouds, media files, documents, and data. This page provides a configuration reference for viewer plugins.

For the complete list of viewers, supported extensions, and extension-to-viewer mapping, see [File Viewers](../concepts/viewers.md).

---

## Viewer Configuration

Viewer plugins are configured in `web/src/visualizerPlugin/config/viewerConfig.json`. Each viewer entry supports the following fields:

| Field                        | Type     | Description                                                                |
| ---------------------------- | -------- | -------------------------------------------------------------------------- |
| `id`                         | string   | Unique plugin identifier                                                   |
| `name`                       | string   | Display name shown in the viewer dropdown                                  |
| `description`                | string   | Tooltip description for the viewer                                         |
| `componentPath`              | string   | Path for Vite dynamic import resolution                                    |
| `supportedExtensions`        | string[] | File extensions this viewer handles                                        |
| `supportsMultiFile`          | boolean  | Whether the viewer can display multiple files simultaneously               |
| `canFullscreen`              | boolean  | Whether fullscreen mode is supported                                       |
| `priority`                   | number   | Lower number = higher preference when multiple viewers match               |
| `loadStrategy`               | string   | `"lazy"` (loaded on demand) or `"eager"` (loaded at startup)               |
| `category`                   | string   | Viewer category (`3d`, `media`, `document`, `data`, `preview`)             |
| `enabled`                    | boolean  | Whether the plugin is active                                               |
| `featuresEnabledRestriction` | string[] | Feature flags required for this viewer to be available                     |
| `requiresPreprocessing`      | boolean  | Whether the viewer needs a pipeline to pre-process files                   |
| `customParameters`           | object   | Viewer-specific configuration (e.g., Cesium ion token, BabylonJS settings) |

---

## Miris Spatial Streaming Viewers

VAMS includes two complementary Miris viewer plugins. Together they let a user upload a USD asset to Miris Spatial Streaming and then stream it back, by selecting either the generated `.mrx` manifest or the original USD source file.

### Stream viewer

The `miris-stream-viewer` plugin streams 3D assets hosted on the Miris Spatial Streaming platform.

| Field               | Value                                                         |
| ------------------- | ------------------------------------------------------------- |
| Plugin ID           | `miris-stream-viewer`                                         |
| Category            | 3D                                                            |
| Supported extension | `.mrx`                                                        |
| Feature flag        | `MIRIS_STREAMING`                                             |
| Description         | Streams a Miris-hosted asset referenced by a `.mrx` manifest. |

The viewer downloads the `.mrx` manifest to read the Miris asset UUID, then streams the asset. While Miris is still preparing the asset (typically 1–2 hours after upload), it shows a "preparing" overlay and refreshes automatically when the asset becomes streamable.

### Upload / USD viewer

The `miris-upload-viewer` plugin handles USD source files and bridges upload and streaming.

| Field                | Value                                                               |
| -------------------- | ------------------------------------------------------------------- |
| Plugin ID            | `miris-upload-viewer`                                               |
| Category             | 3D                                                                  |
| Supported extensions | `.usd`, `.usda`, `.usdc`, `.usdz`                                   |
| Feature flag         | `MIRIS_UPLOAD`                                                      |
| Priority             | `0` (auto-selected over other USD viewers when enabled)             |
| Description          | Streams a USD asset already on Miris, or offers a one-click upload. |

When a USD file is selected, this viewer fetches the asset's file list and:

- **A `.mrx` exists and streaming is configured** — streams the asset by delegating to the stream viewer, so selecting the USD file behaves the same as selecting the `.mrx`.
- **A `.mrx` exists but streaming is not configured** — shows an "Already on Miris" note.
- **No `.mrx` yet** — shows a **Stream with Miris** action that uploads the asset's root USD file to Miris (see the [Miris Auto-Upload Pipeline](../pipelines/miris-upload.md)).

Because it has priority `0`, this viewer is auto-selected for USD files when `MIRIS_UPLOAD` is enabled. The viewer selector remains available to switch to another USD viewer (for example, Needle USD).

:::note
Both Miris viewers require a viewer key configured at deployment time via `app.miris.viewerKey` in the CDK configuration. The upload viewer additionally requires the `MIRIS_UPLOAD` feature (`app.miris.upload.enabled`). See [Configuration Reference](../deployment/configuration-reference.md) for details.
:::

---

## Creating Custom Viewers

For instructions on developing and registering custom viewer plugins, refer to the viewer plugin development guide at `web/src/visualizerPlugin/README.md` and the [FAQ](../troubleshooting/faq.md#how-do-i-add-a-custom-3d-viewer).
