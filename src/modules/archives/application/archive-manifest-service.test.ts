import { describe, expect, it } from "vitest";

import { canonicalJson } from "@/modules/governance/domain/idempotency";

import { APM_054_ARCHIVE_V1 } from "../fixtures/apm-054-archive-v1.fixture";
import { ArchiveManifestError, createProjectArchiveManifest } from "./archive-manifest-service";

const file = {
  id: "file-1",
  projectId: "project-1",
  status: "AVAILABLE",
  scannedAt: new Date("2026-08-11T00:00:00.000Z"),
  storageArea: "CONTROLLED",
  sha256: "a".repeat(64),
  mimeType: "application/pdf",
  size: 42
} as const;

function expectManifestError(operation: () => unknown, code: string) {
  try {
    operation();
    throw new Error("expected archive manifest operation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveManifestError);
    expect(error).toMatchObject({ code });
  }
}

describe("project archive manifest", () => {
  it("keeps the APM-054 snapshot and hashes byte-for-byte", () => {
    const actual = createProjectArchiveManifest({
      projectId: APM_054_ARCHIVE_V1.projectId,
      items: APM_054_ARCHIVE_V1.sources
    });

    expect(canonicalJson(actual.snapshotJson).serialized).toBe(
      APM_054_ARCHIVE_V1.snapshotJsonText
    );
    expect(actual.manifestChecksum).toBe(APM_054_ARCHIVE_V1.manifestChecksum);
    expect(actual.sourceWatermark).toBe(APM_054_ARCHIVE_V1.sourceWatermark);
    expect(actual.items.map((item) => item.sourceChecksum)).toEqual(
      APM_054_ARCHIVE_V1.itemChecksums
    );
  });

  it("freezes exact source facts in a stable sorted checksum and marks external publication not applicable", () => {
    const first = createProjectArchiveManifest({
      projectId: "project-1",
      items: [
        {
          sourceType: "GATE_SUBMISSION",
          sourceId: "gate-1",
          sourceVersion: "3",
          snapshotJson: { status: "APPROVED", gateCode: "G9" }
        },
        {
          sourceType: "CONTROLLED_DOCUMENT_VERSION",
          sourceId: "doc-version-1",
          sourceVersion: "7",
          file,
          snapshotJson: { documentCode: "DOC-001", status: "PUBLISHED" }
        }
      ]
    });
    const reordered = createProjectArchiveManifest({
      projectId: "project-1",
      items: [
        {
          sourceType: "CONTROLLED_DOCUMENT_VERSION",
          sourceId: "doc-version-1",
          sourceVersion: "7",
          file,
          snapshotJson: { documentCode: "DOC-001", status: "PUBLISHED" }
        },
        {
          sourceType: "GATE_SUBMISSION",
          sourceId: "gate-1",
          sourceVersion: "3",
          snapshotJson: { status: "APPROVED", gateCode: "G9" }
        }
      ]
    });

    expect(first.externalPublication).toEqual({
      applicability: "NOT_APPLICABLE",
      reason: "外部供应商包能力尚未实现。"
    });
    expect(first.items).toEqual([
      expect.objectContaining({
        sourceId: "doc-version-1",
        sourceVersion: "7",
        fileObjectId: "file-1",
        fileSha256: "a".repeat(64),
        fileMimeType: "application/pdf",
        fileSize: 42n
      }),
      expect.objectContaining({ sourceId: "gate-1", sourceVersion: "3" })
    ]);
    expect(first.manifestChecksum).toBe(reordered.manifestChecksum);
    expect(first.sourceWatermark).toBe(reordered.sourceWatermark);
  });

  it("rejects a non-current-project, unscanned, unavailable, or non-controlled source file", () => {
    for (const invalid of [
      { ...file, projectId: "project-2" },
      { ...file, scannedAt: null },
      { ...file, status: "QUARANTINED" },
      { ...file, storageArea: "QUARANTINE" }
    ]) {
      expectManifestError(
        () =>
          createProjectArchiveManifest({
            projectId: "project-1",
            items: [
              {
                sourceType: "CONTROLLED_DOCUMENT_VERSION",
                sourceId: "doc-version-1",
                sourceVersion: "7",
                file: invalid,
                snapshotJson: { documentCode: "DOC-001" }
              }
            ]
          }),
        "ARCHIVE_SOURCE_FILE_INVALID"
      );
    }
  });

  it("rejects mutable current pointers and excludes APM-053 internal selection sets from the manifest", () => {
    expectManifestError(
      () =>
        createProjectArchiveManifest({
          projectId: "project-1",
          items: [
            {
              sourceType: "CONTROLLED_DOCUMENT_VERSION",
              sourceId: "document-1",
              sourceVersion: "CURRENT",
              file,
              snapshotJson: { documentCode: "DOC-001" }
            }
          ]
        }),
      "ARCHIVE_SOURCE_VERSION_REQUIRED"
    );

    const manifest = createProjectArchiveManifest({
      projectId: "project-1",
      items: [
        {
          sourceType: "DRAWING_SELECTION_SET",
          sourceId: "selection-1",
          sourceVersion: "1",
          snapshotJson: { code: "SEL-001" }
        },
        {
          sourceType: "MECHANICAL_DRAWING_VERSION",
          sourceId: "drawing-version-1",
          sourceVersion: "2",
          file,
          snapshotJson: { drawingNumber: "DWG-001" }
        }
      ]
    });
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0]).toMatchObject({ sourceId: "drawing-version-1" });
  });
});
