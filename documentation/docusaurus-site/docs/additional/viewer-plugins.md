# Viewer Plugins

VAMS includes a plugin-based viewer architecture with 20 built-in viewer plugins for visualizing 3D models, point clouds, media files, documents, and data. This page provides a configuration reference for viewer plugins.

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
| `priority`                   | number   | Lower number = listed first when multiple viewers match                    |
| `loadStrategy`               | string   | `"lazy"` (loaded on demand) or `"eager"` (loaded at startup)               |
| `category`                   | string   | Viewer category (`3d`, `media`, `document`, `data`, `preview`)             |
| `enabled`                    | boolean  | Whether the plugin is active                                               |
| `featuresEnabledRestriction` | string[] | Feature flags required for this viewer to be available                     |
| `requiresPreprocessing`      | boolean  | Whether the viewer needs a pipeline to pre-process files                   |
| `customParameters`           | object   | Viewer-specific configuration (e.g., Cesium ion token, BabylonJS settings) |

---

## Miris Spatial Streaming Viewer

VAMS includes one Miris viewer plugin, which streams the Miris asset recorded in a USD file's stream metadata.

| Plugin ID             | Extensions                        | Priority | Feature flag      | Role                                                                                                                          |
| --------------------- | --------------------------------- | -------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `miris-stream-viewer` | `.usd`, `.usda`, `.usdc`, `.usdz` | 0        | `MIRIS_STREAMING` | Streams the Miris asset recorded in the file's `miris_asset_uuid` metadata, or shows how to stream it. Auto-selected for USD. |

:::note
For configuration, the stream metadata, the upload flow, architecture, and requirements, see the dedicated [Miris Spatial Streaming Integration](../developer/external-integrations/miris-spatial-streaming.md) guide. The viewer requires a viewer key configured via `app.miris.viewerKey`.
:::

---

## Creating Custom Viewers

For instructions on developing and registering custom viewer plugins, refer to the viewer plugin development guide at `web/src/visualizerPlugin/README.md` and the [FAQ](../troubleshooting/faq.md#how-do-i-add-a-custom-3d-viewer).
