import { describe, expect, it, vi } from "vitest";

import { readProjectArchiveSources } from "./archive-source-reader";

describe("archive source reader", () => {
  it("reads only exact project facts and preserves published file metadata", async () => {
    const client = {
      project: { findUnique: vi.fn().mockResolvedValue({ id: "project-1" }) },
      controlledDocumentVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "doc-version-1",
            version: 2,
            sourceFile: {
              id: "file-1",
              projectId: "project-1",
              status: "AVAILABLE",
              scannedAt: new Date("2026-08-11T00:00:00.000Z"),
              storageArea: "CONTROLLED",
              sha256: "a".repeat(64),
              verifiedMimeType: "application/pdf",
              declaredMimeType: "application/pdf",
              verifiedSize: 10n,
              declaredSize: 10n
            },
            document: { code: "DOC-001", title: "规范" }
          }
        ])
      },
      mechanicalDrawingVersionFile: { findMany: vi.fn().mockResolvedValue([]) },
      documentReview: { findMany: vi.fn().mockResolvedValue([]) },
      gateSubmission: { findMany: vi.fn().mockResolvedValue([]) },
      acceptanceBatch: { findMany: vi.fn().mockResolvedValue([]) },
      acceptanceReport: { findMany: vi.fn().mockResolvedValue([]) },
      acceptanceConfirmation: { findMany: vi.fn().mockResolvedValue([]) }
    };

    const sources = await readProjectArchiveSources({
      projectId: "project-1",
      client
    });

    expect(client.project.findUnique).toHaveBeenCalledWith({
      where: { id: "project-1" },
      select: { id: true }
    });
    expect(client.controlledDocumentVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "project-1", status: "PUBLISHED" } })
    );
    expect(sources).toEqual([
      expect.objectContaining({
        sourceType: "CONTROLLED_DOCUMENT_VERSION",
        sourceId: "doc-version-1",
        sourceVersion: "2",
        file: expect.objectContaining({ id: "file-1", size: 10n })
      })
    ]);
  });

  it("fails closed when the project does not exist", async () => {
    const client = {
      project: { findUnique: vi.fn().mockResolvedValue(null) }
    };
    await expect(readProjectArchiveSources({ projectId: "missing", client })).rejects.toMatchObject(
      {
        code: "ARCHIVE_SOURCE_FACTS_UNAVAILABLE"
      }
    );
  });
});
