import { parseMirisManifest, MirisManifestErrorReason } from "./manifestParser";

const VALID_UUID = "063393b4-4b0d-4196-a6d4-ebcde70c56c2";

describe("parseMirisManifest", () => {
    it("accepts a minimal valid v1 manifest", () => {
        const input = JSON.stringify({
            schemaVersion: 1,
            mirisAssetUuid: VALID_UUID,
        });
        const result = parseMirisManifest(input);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.manifest.mirisAssetUuid).toBe(VALID_UUID);
            expect(result.manifest.schemaVersion).toBe(1);
        }
    });

    it("accepts a full v1 manifest with optional fields", () => {
        const input = JSON.stringify({
            schemaVersion: 1,
            mirisAssetUuid: VALID_UUID,
            displayName: "Test Asset",
            tags: ["a", "b"],
            uploadedAt: "2026-06-15T12:00:00Z",
            uploadedBy: "test@example.com",
        });
        const result = parseMirisManifest(input);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.manifest.displayName).toBe("Test Asset");
            expect(result.manifest.tags).toEqual(["a", "b"]);
        }
    });

    it("rejects missing mirisAssetUuid", () => {
        const input = JSON.stringify({ schemaVersion: 1 });
        const result = parseMirisManifest(input);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe(MirisManifestErrorReason.MISSING_UUID);
        }
    });

    it("rejects invalid UUID format", () => {
        const input = JSON.stringify({
            schemaVersion: 1,
            mirisAssetUuid: "not-a-uuid",
        });
        const result = parseMirisManifest(input);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe(MirisManifestErrorReason.INVALID_UUID);
        }
    });

    it("rejects schemaVersion: 2 with UNSUPPORTED_SCHEMA", () => {
        const input = JSON.stringify({
            schemaVersion: 2,
            mirisAssetUuid: VALID_UUID,
        });
        const result = parseMirisManifest(input);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe(MirisManifestErrorReason.UNSUPPORTED_SCHEMA);
        }
    });

    it("rejects schemaVersion: 0 with INVALID_SCHEMA", () => {
        const input = JSON.stringify({
            schemaVersion: 0,
            mirisAssetUuid: VALID_UUID,
        });
        const result = parseMirisManifest(input);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe(MirisManifestErrorReason.INVALID_SCHEMA);
        }
    });

    it("rejects missing schemaVersion with INVALID_SCHEMA", () => {
        const input = JSON.stringify({ mirisAssetUuid: VALID_UUID });
        const result = parseMirisManifest(input);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe(MirisManifestErrorReason.INVALID_SCHEMA);
        }
    });

    it("rejects malformed JSON with INVALID_JSON", () => {
        const result = parseMirisManifest("not json {{");
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe(MirisManifestErrorReason.INVALID_JSON);
        }
    });

    it("rejects oversized input (>16 KB) with TOO_LARGE", () => {
        const padded = JSON.stringify({
            schemaVersion: 1,
            mirisAssetUuid: VALID_UUID,
            displayName: "x".repeat(17 * 1024),
        });
        const result = parseMirisManifest(padded);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe(MirisManifestErrorReason.TOO_LARGE);
        }
    });
});
