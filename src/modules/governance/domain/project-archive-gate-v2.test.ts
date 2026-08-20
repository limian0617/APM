import { describe, expect, it } from "vitest";

import { evaluateProjectArchiveGateV2 } from "./project-archive-gate-v2";

const base = {
  factsAvailable: true,
  projectId: "project-1",
  scope: "PROJECT" as const,
  archiveA: {
    id: "archive-a",
    status: "READY",
    archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
    retrospectiveInputApplicability: "APPLICABLE",
    retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
    retrospectiveInputWatermark: "a".repeat(64)
  },
  archiveB: {
    id: "archive-b",
    status: "READY",
    archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
    retrospectiveInputApplicability: "APPLICABLE",
    retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
    retrospectiveInputWatermark: "a".repeat(64),
    manifestChecksum: "b".repeat(64),
    sourceWatermark: "c".repeat(64),
    latestIntegrityCheck: { id: "integrity-b", status: "PASSED" },
    sourceFactsCurrent: true
  },
  approvedRetrospective: {
    id: "retrospective-version-1",
    status: "APPROVED",
    contentChecksum: "d".repeat(64),
    retrospectiveInputArchiveVersionId: "archive-a"
  },
  currentRetrospectiveVersionId: "retrospective-version-1",
  latestApprovedRetrospectiveVersionId: "retrospective-version-1",
  archiveBIncludesRetrospectiveVersion: true,
  openResidualItemIds: [] as string[]
};

describe("CLOSURE.ARCHIVE.G9@2", () => {
  it("passes only when the V2 Archive A/B watermarks, B integrity, current sources, and approved retrospective agree", () => {
    expect(evaluateProjectArchiveGateV2(base)).toMatchObject({
      status: "PASSED",
      code: "CLOSURE_ARCHIVE_V2_READY",
      evidence: {
        archiveAId: "archive-a",
        archiveBId: "archive-b",
        archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
        integrityStatus: "PASSED"
      }
    });
  });

  it.each([
    ["missing facts", { factsAvailable: false }],
    [
      "legacy Archive A formula",
      { archiveA: { ...base.archiveA, archiveSourceFormulaVersion: "ARCHIVE.SOURCE@1" } }
    ],
    ["Archive A not ready", { archiveA: { ...base.archiveA, status: "FAILED" } }],
    [
      "watermark mismatch",
      { archiveB: { ...base.archiveB, retrospectiveInputWatermark: "z".repeat(64) } }
    ],
    ["B not ready", { archiveB: { ...base.archiveB, status: "FAILED" } }],
    [
      "latest integrity failed",
      {
        archiveB: {
          ...base.archiveB,
          latestIntegrityCheck: { id: "integrity-b", status: "FAILED" }
        }
      }
    ],
    ["latest integrity missing", { archiveB: { ...base.archiveB, latestIntegrityCheck: null } }],
    ["source facts stale", { archiveB: { ...base.archiveB, sourceFactsCurrent: false } }],
    ["retrospective pointer stale", { currentRetrospectiveVersionId: "new-draft" }],
    [
      "retrospective checksum missing",
      { approvedRetrospective: { ...base.approvedRetrospective, contentChecksum: null } }
    ],
    ["retrospective omitted from B", { archiveBIncludesRetrospectiveVersion: false }],
    ["residual item open", { openResidualItemIds: ["residual-1"] }]
  ])("hard fails %s", (_label, override) => {
    expect(evaluateProjectArchiveGateV2({ ...base, ...override })).toMatchObject({
      status: "HARD_FAILED"
    });
  });
});
