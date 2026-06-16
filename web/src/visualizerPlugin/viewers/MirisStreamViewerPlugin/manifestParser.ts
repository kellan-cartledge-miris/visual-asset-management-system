/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Pure parser + validator for .mrx manifest files.
 * Returns a discriminated union: { ok: true, manifest } or { ok: false, reason, detail? }.
 */

export const SUPPORTED_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 16 * 1024;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export enum MirisManifestErrorReason {
    INVALID_JSON = "INVALID_JSON",
    TOO_LARGE = "TOO_LARGE",
    INVALID_SCHEMA = "INVALID_SCHEMA",
    UNSUPPORTED_SCHEMA = "UNSUPPORTED_SCHEMA",
    MISSING_UUID = "MISSING_UUID",
    INVALID_UUID = "INVALID_UUID",
}

export interface MirisManifest {
    schemaVersion: 1;
    mirisAssetUuid: string;
    displayName?: string;
    tags?: string[];
    uploadedAt?: string;
    uploadedBy?: string;
}

export type MirisManifestResult =
    | { ok: true; manifest: MirisManifest }
    | { ok: false; reason: MirisManifestErrorReason; detail?: string };

export function parseMirisManifest(raw: string): MirisManifestResult {
    if (raw.length > MAX_MANIFEST_BYTES) {
        return { ok: false, reason: MirisManifestErrorReason.TOO_LARGE };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return { ok: false, reason: MirisManifestErrorReason.INVALID_JSON };
    }

    if (typeof parsed !== "object" || parsed === null) {
        return { ok: false, reason: MirisManifestErrorReason.INVALID_SCHEMA };
    }

    const obj = parsed as Record<string, unknown>;

    if (typeof obj.schemaVersion !== "number") {
        return { ok: false, reason: MirisManifestErrorReason.INVALID_SCHEMA };
    }
    if (obj.schemaVersion <= 0) {
        return { ok: false, reason: MirisManifestErrorReason.INVALID_SCHEMA };
    }
    if (obj.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
        return { ok: false, reason: MirisManifestErrorReason.UNSUPPORTED_SCHEMA };
    }

    if (obj.mirisAssetUuid === undefined || obj.mirisAssetUuid === null) {
        return { ok: false, reason: MirisManifestErrorReason.MISSING_UUID };
    }
    if (typeof obj.mirisAssetUuid !== "string" || !UUID_REGEX.test(obj.mirisAssetUuid)) {
        return { ok: false, reason: MirisManifestErrorReason.INVALID_UUID };
    }

    const manifest: MirisManifest = {
        schemaVersion: 1,
        mirisAssetUuid: obj.mirisAssetUuid,
    };
    if (typeof obj.displayName === "string") manifest.displayName = obj.displayName;
    if (Array.isArray(obj.tags) && obj.tags.every((t) => typeof t === "string")) {
        manifest.tags = obj.tags as string[];
    }
    if (typeof obj.uploadedAt === "string") manifest.uploadedAt = obj.uploadedAt;
    if (typeof obj.uploadedBy === "string") manifest.uploadedBy = obj.uploadedBy;

    return { ok: true, manifest };
}
