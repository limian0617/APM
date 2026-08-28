import { describe, expect, it } from "vitest";

import { evaluateProjectArchiveGate } from "./project-archive-gate";

const base = {
  factsAvailable: true,
  projectId: "project-1",
  scope: "PROJECT" as const,
  archiveVersionId: "archive-version-1",
  archiveStatus: "READY",
  manifestChecksum: "a".repeat(64),
  sourceWatermark: "b".repeat(64),
  integrityCheckId: "check-1",
  integrityStatus: "PASSED",
  sourceFactsCurrent: true,
  openResidualItemIds: [] as string[]
};

describe("CLOSURE.ARCHIVE.G9", () => {
  it("passes only with an exact ready archive and no open residuals", () => {
    expect(evaluateProjectArchiveGate(base)).toMatchObject({
      status: "PASSED",
      code: "CLOSURE_ARCHIVE_READY"
    });
  });

  it("hard fails missing facts, stale watermarks, non-ready versions, or residuals", () => {
    for (const facts of [
      { ...base, factsAvailable: false },
      { ...base, sourceFactsCurrent: false },
      { ...base, archiveStatus: "FAILED" },
      { ...base, integrityStatus: "FAILED" },
      { ...base, openResidualItemIds: ["residual-1"] },
      { ...base, scope: "DELIVERY_UNIT" as const }
    ]) {
      expect(evaluateProjectArchiveGate(facts)).toMatchObject({ status: "HARD_FAILED" });
    }
  });
});
