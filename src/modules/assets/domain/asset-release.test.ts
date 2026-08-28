import { describe, expect, it } from "vitest";

import {
  ASSET_COMPONENT_TYPES,
  ASSET_RELEASE_VERSION_STATUSES,
  AssetReleaseError,
  assertAssetReleaseTransition,
  assertComponentPositionsUnique,
  assertPublishedVersionImmutable,
  canonicalAssetReleaseSnapshot,
  validateAssetComponentSnapshot,
  validateAssetReleaseCode
} from "./asset-release";

describe("APM-062 asset release domain", () => {
  it("accepts the minimum release lifecycle and rejects edits to published payloads", () => {
    expect(ASSET_RELEASE_VERSION_STATUSES).toEqual(["DRAFT", "PUBLISHED", "SUPERSEDED"]);
    expect(assertAssetReleaseTransition("DRAFT", "PUBLISHED")).toBeUndefined();
    expect(assertAssetReleaseTransition("PUBLISHED", "SUPERSEDED")).toBeUndefined();
    expect(() => assertAssetReleaseTransition("PUBLISHED", "DRAFT")).toThrow(
      expect.objectContaining({ code: "INVALID_RELEASE_TRANSITION", status: 409 })
    );
    expect(() =>
      assertPublishedVersionImmutable({
        status: "PUBLISHED",
        changedFields: ["releaseNotes"]
      })
    ).toThrow(expect.objectContaining({ code: "PUBLISHED_VERSION_IMMUTABLE", status: 409 }));
    expect(() =>
      assertPublishedVersionImmutable({
        status: "PUBLISHED",
        changedFields: ["status"]
      })
    ).not.toThrow();
  });

  it("normalizes release codes and validates typed source snapshots", () => {
    expect(validateAssetReleaseCode(" rel-mech-01 ")).toBe("REL-MECH-01");
    expect(() => validateAssetReleaseCode("x")).toThrow(
      expect.objectContaining({ code: "INVALID_RELEASE_CODE" })
    );
    expect(ASSET_COMPONENT_TYPES).toEqual(["MECHANICAL_DRAWING", "SOFTWARE", "VALIDATION_REPORT"]);
    expect(
      validateAssetComponentSnapshot({
        componentType: "MECHANICAL_DRAWING",
        position: 1,
        sourceProjectId: "project-1",
        sourceDocumentVersionId: "document-version-1",
        sourceVersion: 3,
        sourceStatus: "PUBLISHED",
        sourceChecksum: "a".repeat(64),
        files: [
          {
            fileId: "file-cad",
            sha256: "b".repeat(64),
            mimeType: "application/acad",
            size: 10
          }
        ],
        metadata: { drawingNumber: "DWG-001" }
      })
    ).toMatchObject({ componentType: "MECHANICAL_DRAWING", position: 1 });
    expect(() =>
      validateAssetComponentSnapshot({
        componentType: "SOFTWARE",
        position: 1,
        sourceProjectId: "project-1",
        sourceDocumentVersionId: "document-version-1",
        sourceVersion: 1,
        sourceStatus: "DRAFT",
        sourceChecksum: "c".repeat(64),
        files: [],
        metadata: {}
      })
    ).toThrow(expect.objectContaining({ code: "SOURCE_VERSION_NOT_PUBLISHED" }));
  });

  it("rejects duplicate positions and produces a deterministic canonical snapshot", () => {
    expect(() => assertComponentPositionsUnique([{ position: 1 }, { position: 1 }])).toThrow(
      expect.objectContaining({ code: "DUPLICATE_COMPONENT_POSITION" })
    );
    const first = canonicalAssetReleaseSnapshot({
      releaseCode: "REL-01",
      revision: 1,
      components: [
        { position: 2, componentType: "SOFTWARE", sourceVersion: 2 },
        { position: 1, componentType: "MECHANICAL_DRAWING", sourceVersion: 1 }
      ]
    });
    const second = canonicalAssetReleaseSnapshot({
      releaseCode: " rel-01 ",
      revision: 1,
      components: [
        { position: 1, componentType: "MECHANICAL_DRAWING", sourceVersion: 1 },
        { position: 2, componentType: "SOFTWARE", sourceVersion: 2 }
      ]
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ releaseCode: "REL-01", revision: 1 });
  });

  it("exposes a typed domain error for callers", () => {
    const error = new AssetReleaseError("SOURCE_NOT_FOUND", "来源不存在", 404);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "SOURCE_NOT_FOUND", status: 404 });
  });
});
