# Miris API Reference

This page documents the VAMS REST API surface for Miris spatial streaming. The route is deployed only when `app.miris.enabled` is `true` in `infra/config/config.json`, whether or not the Miris upload pipeline is enabled.

See [Miris Spatial Streaming](../developer/external-integrations/miris-spatial-streaming.md) for the integration as a whole.

---

## Stream status

### GET `/database/{databaseId}/assets/{assetId}/miris/asset-status`

Returns the Miris stream recorded on one asset file and the stream's processing state. The streaming viewer calls it with the path of the file being viewed.

The Miris asset UUID is read server side from the file's metadata. The request carries no UUID, so a caller can only learn the status of a stream that the file itself references. The handler reads these file metadata keys for exactly the given database, asset, and file path:

| Metadata key              | Response field    | Description                                                                                               |
| ------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| `miris_asset_uuid`        | `mirisAssetUuid`  | Miris asset to stream.                                                                                    |
| `miris_source_version_id` | `sourceVersionId` | Amazon S3 version ID of the file the stream was made from. An empty string means the version was unknown. |
| `miris_uploaded_at`       | `uploadedAt`      | When the Miris upload completed (ISO 8601).                                                               |
| `miris_display_name`      | `displayName`     | Label shown in the viewer.                                                                                |

Each field is the stored value, or `null` when the key is absent. `mirisAssetUuid` is also `null` when the stored value is empty.

#### Request parameters

| Parameter    | Location | Required | Description                                                                                                                                                                                                                                                                                 |
| ------------ | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `databaseId` | path     | Yes      | Database identifier.                                                                                                                                                                                                                                                                        |
| `assetId`    | path     | Yes      | Asset identifier.                                                                                                                                                                                                                                                                           |
| `filePath`   | query    | Yes      | Asset-relative path of the file, such as `/scene.usd`, or the file's full object key, such as `/assets/{assetId}/scene.usd`. A missing leading slash is added. A key under the asset's root location or under `{assetId}/` is reduced to the asset-relative path. Maximum 1,024 characters. |

A `filePath` that is missing, empty, contains `..`, or ends with `/` returns `400`.

#### States

| `state`           | Meaning                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notStreamed`     | `miris_asset_uuid` is absent or empty. Miris is not called.                                                                                                                                              |
| `invalidUuid`     | `miris_asset_uuid` is set but is not a UUID. Miris is not called.                                                                                                                                        |
| `unknown`         | The processing state could not be established: no Miris viewer key is configured (Miris is not called), or Miris was unreachable, did not show the asset to the viewer key, or returned no usable state. |
| `preview`         | Miris is still preparing the asset.                                                                                                                                                                      |
| `streamable`      | The asset can be streamed.                                                                                                                                                                               |
| `error`, `failed` | Miris reported a definitive processing failure.                                                                                                                                                          |

Any other state Miris reports is returned as is. The status probe is advisory: the response carries the stored UUID whatever Miris reports, and only `error` and `failed` indicate that the stream cannot play, so the viewer attempts the stream in every other case where a UUID is present. The probe authenticates with the deployment's Miris viewer key (`app.miris.viewerKey`), the same credential the viewer streams with, so it sees exactly the assets the viewer can stream.

#### Example request

```
GET /database/engineering/assets/turbine-v2/miris/asset-status?filePath=%2Fscene.usd
```

#### Example response

```json
{
    "filePath": "/scene.usd",
    "mirisAssetUuid": "8d65af7c-5412-404b-a494-fbd2cdb62442",
    "sourceVersionId": "3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY",
    "uploadedAt": "2026-10-14T12:00:00Z",
    "displayName": "Turbine",
    "state": "streamable"
}
```

#### Error responses

| Status | Description                                                                          |
| ------ | ------------------------------------------------------------------------------------ |
| `400`  | Invalid or missing `filePath`, invalid path parameters, or the asset does not exist. |
| `403`  | The caller lacks API-tier access to the route or `GET` access to the asset.          |
| `500`  | Internal server error.                                                               |

#### Authorization

-   **API tier:** The caller's role must allow `GET` on `/database/{databaseId}/assets/{assetId}/miris/asset-status` through a permission constraint with `objectType: "api"`.
-   **Object tier:** The caller must have `GET` permission on the asset (`objectType: "asset"`). This check runs before any metadata is read.

Because the response carries the stream metadata, viewing a stream does not require access to the file metadata routes.
