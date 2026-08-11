import { describe, expect, it } from "vitest";

import { ProjectCloseError, assertProjectCanClose } from "./project-close-service";

const facts = {
  projectId: "project-1",
  projectStatus: "IN_PROGRESS",
  projectVersion: 4,
  expectedProjectVersion: 4,
  g9Approved: true,
  g9ArchiveVersionId: "archive-version-1",
  archiveVersionId: "archive-version-1",
  archiveStatus: "READY",
  manifestChecksum: "a".repeat(64),
  g9ManifestChecksum: "a".repeat(64),
  sourceWatermark: "b".repeat(64),
  g9SourceWatermark: "b".repeat(64),
  sourceFactsCurrent: true,
  openResidualItemIds: [] as string[]
};

describe("project closure", () => {
  it("accepts only an approved, exact ready archive with no residuals", () => {
    expect(assertProjectCanClose(facts)).toBeUndefined();
  });

  it("fails closed when G9 approval, archive facts, residuals, or optimistic version is stale", () => {
    const cases: Array<[string, Partial<typeof facts>]> = [
      ["PROJECT_G9_NOT_APPROVED", { g9Approved: false }],
      ["PROJECT_ARCHIVE_NOT_READY", { archiveStatus: "FAILED" }],
      ["PROJECT_ARCHIVE_FACTS_STALE", { g9ManifestChecksum: "c".repeat(64) }],
      ["PROJECT_RESIDUALS_OPEN", { openResidualItemIds: ["residual-1"] }],
      ["PROJECT_VERSION_CONFLICT", { expectedProjectVersion: 3 }]
    ];
    for (const [code, override] of cases) {
      expect(() => assertProjectCanClose({ ...facts, ...override })).toThrowError(
        expect.objectContaining({ code })
      );
    }
  });

  it("rejects closure when sources changed after the ready archive was checked", () => {
    expect(() => assertProjectCanClose({ ...facts, sourceFactsCurrent: false })).toThrowError(
      expect.objectContaining({ code: "PROJECT_ARCHIVE_FACTS_STALE", status: 409 })
    );
  });
});
