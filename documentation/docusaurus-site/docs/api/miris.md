# Miris API Reference

This page documents the VAMS REST API surface for Miris spatial streaming. The routes are deployed only when `app.miris.enabled` is `true` in `infra/config/config.json`, whether or not the Miris upload pipeline is enabled. The [viewer key route](#per-view-viewer-key) is deployed only when `app.miris.viewerKeyMode` is also `perView`.

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

The keys are read from the file's current metadata, even when the caller is viewing a historical asset version: the endpoint does not read the metadata snapshot saved with an asset version, so it returns the stream recorded on the file now. See [Stream metadata](../developer/external-integrations/miris-spatial-streaming.md#stream-metadata) for how the keys are written and edited.

#### Request parameters

| Parameter    | Location | Required | Description                                                                                                                                                                                                                                                                                 |
| ------------ | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `databaseId` | path     | Yes      | Database identifier.                                                                                                                                                                                                                                                                        |
| `assetId`    | path     | Yes      | Asset identifier.                                                                                                                                                                                                                                                                           |
| `filePath`   | query    | Yes      | Asset-relative path of the file, such as `/scene.usd`, or the file's full object key, such as `/assets/{assetId}/scene.usd`. A missing leading slash is added. A key under the asset's root location or under `{assetId}/` is reduced to the asset-relative path. Maximum 1,024 characters. |

A `filePath` that is missing, empty, contains `..`, or ends with `/` returns `400`.

At most one prefix is removed, so an asset-relative path whose first segments match the asset's root key or `{assetId}/` is ambiguous: for an asset with ID `turbine-v2`, the asset-relative path `/turbine-v2/scene.usd` is read as the full key and reduced to `/scene.usd`. The full object key is always unambiguous; the streaming viewer sends it.

#### States

| `state`           | Meaning                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notStreamed`     | `miris_asset_uuid` is absent or empty. Miris is not called.                                                                                                                                                                    |
| `invalidUuid`     | `miris_asset_uuid` is set but is not a UUID. Miris is not called.                                                                                                                                                              |
| `unknown`         | The processing state could not be established: no Miris viewer key or Miris API base URL is configured (Miris is not called), or Miris was unreachable, did not show the asset to the viewer key, or returned no usable state. |
| `processing`      | Miris is still preparing the asset and does not yet show it to the viewer key (the Miris viewer API returned HTTP 400). Static mode only.                                                                                      |
| `preview`         | Miris is still preparing the asset.                                                                                                                                                                                            |
| `streamable`      | The asset can be streamed.                                                                                                                                                                                                     |
| `error`, `failed` | Miris reported a definitive processing failure.                                                                                                                                                                                |

Any other state Miris reports is returned as is. The status probe is advisory: the response carries the stored UUID whatever Miris reports, and only `error` and `failed` indicate that the stream cannot play, so the viewer attempts the stream in every other case where a UUID is present.

How the probe authenticates depends on `app.miris.viewerKeyMode`:

-   **`static`** (default): the probe calls the Miris viewer API with the deployment's Miris viewer key (`app.miris.viewerKey`), the same credential the viewer streams with, so it sees exactly the assets the viewer can stream.
-   **`perView`**: no deployment-wide viewer key exists. The probe reads the asset (`GET /v1/asset/{uuid}`) with the Miris Integration Key from `app.miris.apiKeySecretArn`. A Miris 404, any other error, or a response without a usable state is reported as `unknown`.

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

---

## Per-view viewer key

### POST `/database/{databaseId}/assets/{assetId}/miris/viewer-key`

Mints a short-lived Miris viewer key that can stream only the Miris asset recorded on one asset file. The streaming viewer calls it each time it opens a stream in per-view mode. The route exists only when `app.miris.viewerKeyMode` is `perView`.

The Miris asset UUID is read server side from the file's `miris_asset_uuid` metadata key, as the [stream status](#stream-status) endpoint reads it; the request carries no UUID. VAMS creates the key with the Miris Integration Key (`app.miris.apiKeySecretArn`), scoped to exactly that Miris asset and expiring `app.miris.perViewKey.ttlMinutes` minutes after it is minted.

The key material is returned in this response only. VAMS records the key ID, database, asset, file path, user, Miris asset UUID, and expiry in the Miris viewer key table and writes the same fields to the `AUTHOTHER` audit log (type `mirisViewerKeyMint`); neither holds the key material. After the key expires, VAMS deletes it from the Miris workspace. A stream that is already open keeps playing after its key expires; the expiry stops new streams from starting with that key.

#### Request parameters

| Parameter    | Location | Required | Description                                                                                                        |
| ------------ | -------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `databaseId` | path     | Yes      | Database identifier.                                                                                               |
| `assetId`    | path     | Yes      | Asset identifier.                                                                                                  |
| `filePath`   | body     | Yes      | Asset-relative path or full object key of the file, in the same forms and with the same rules as the status route. |

#### Example request

```
POST /database/engineering/assets/turbine-v2/miris/viewer-key
```

```json
{
    "filePath": "/scene.usd"
}
```

#### Example response

```json
{
    "filePath": "/scene.usd",
    "mirisAssetUuid": "8d65af7c-5412-404b-a494-fbd2cdb62442",
    "viewerKey": "<viewer key>",
    "expiresAt": "2026-10-15T19:04:28Z"
}
```

| Field            | Description                                                 |
| ---------------- | ----------------------------------------------------------- |
| `filePath`       | The normalized asset-relative path of the file.             |
| `mirisAssetUuid` | The Miris asset the key can stream.                         |
| `viewerKey`      | The viewer key material.                                    |
| `expiresAt`      | When the key stops authorizing new streams (RFC 3339, UTC). |

The response carries `Cache-Control: no-cache, no-store`.

#### Error responses

| Status | Description                                                                                                                                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Invalid or missing `filePath`, invalid path parameters, or the asset does not exist. Also returned with `state: "invalidUuid"` when the file's `miris_asset_uuid` is not a UUID. |
| `403`  | The caller lacks API-tier access to `POST` on the route or `GET` access to the asset.                                                                                            |
| `404`  | The file records no Miris stream (`state: "notStreamed"`).                                                                                                                       |
| `500`  | Internal server error, including a key that could not be recorded. VAMS deletes such a key from Miris before responding.                                                         |
| `502`  | Miris did not create a usable key. A key Miris created without key material is deleted from Miris. The Miris response is not passed through.                                     |

#### Authorization

-   **API tier:** The caller's role must allow `POST` on `/database/{databaseId}/assets/{assetId}/miris/viewer-key` through a permission constraint with `objectType: "api"`. API-tier constraints match the request path and the HTTP method, so this is separate from the `GET` permission the status route needs; a role that streams in per-view mode needs both. The `database-admin` and `database-user` permission templates allow `POST` on routes starting with `/database` and so cover it. The `database-readonly` and `global-readonly` templates and the seeded default read-only role (`basicReadOnly`) allow `POST` on this route only, through a separate constraint whose two `criteriaAnd` criteria both match `route__path`: `starts_with` `/database` and `ends_with` `/miris/viewer-key`. The seeded role's constraints are rewritten on every deployment, but stored roles are not: a role built from an earlier copy of a read-only template does not carry the constraint until the template is re-imported or the constraint is added. A custom role needs a constraint that allows `POST` on this route; without one its users receive `403` from it.
-   **Object tier:** The caller must have `GET` permission on the asset (`objectType: "asset"`), the same check as the status route. A viewer key grants streaming only, so minting one is authorized as a read of the asset. This check runs before any metadata is read.
