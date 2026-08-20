import { describe, expect, it } from "vitest";

import { evaluateProjectRetrospectiveGate } from "./project-retrospective-gate";

const base = {
  factsAvailable: true,
  projectId: "project-1",
  scope: "PROJECT" as const,
  currentVersionId: "retrospective-v1",
  latestApprovedVersionId: "retrospective-v1",
  retrospective: {
    id: "retrospective-v1",
    status: "APPROVED",
    contentChecksum: "a".repeat(64),
    retrospectiveInputArchiveVersionId: "archive-a",
    retrospectiveInputManifestChecksum: "b".repeat(64),
    retrospectiveInputSourceWatermark: "c".repeat(64),
    retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
    retrospectiveInputWatermark: "d".repeat(64),
    independentReviewer: true,
    requiredContributionsComplete: true
  },
  archiveA: {
    id: "archive-a",
    status: "READY",
    archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
    retrospectiveInputApplicability: "APPLICABLE",
    retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
    retrospectiveInputWatermark: "d".repeat(64),
    manifestChecksum: "b".repeat(64),
    sourceWatermark: "c".repeat(64)
  },
  archiveB: {
    id: "archive-b",
    status: "READY",
    archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
    retrospectiveInputApplicability: "APPLICABLE",
    retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
    retrospectiveInputWatermark: "d".repeat(64),
    manifestChecksum: "e".repeat(64),
    sourceWatermark: "f".repeat(64),
    latestIntegrityCheck: { id: "integrity-b", status: "PASSED" },
    sourceFactsCurrent: true,
    includesRetrospectiveVersion: true
  }
};

describe("CLOSURE.RETROSPECTIVE.G9@1", () => {
  it("passes an approved current retrospective frozen between matching V2 Archive A and B inputs", () => {
    expect(evaluateProjectRetrospectiveGate(base)).toMatchObject({
      status: "PASSED",
      code: "CLOSURE_RETROSPECTIVE_READY",
      evidence: {
        retrospectiveVersionId: "retrospective-v1",
        retrospectiveInputArchiveVersionId: "archive-a",
        archiveBId: "archive-b",
        archiveBManifestChecksum: "e".repeat(64),
        archiveBSourceWatermark: "f".repeat(64),
        archiveBIntegrityStatus: "PASSED",
        archiveBSourceFactsCurrent: true
      }
    });
  });

  it.each([
    ["missing facts", { factsAvailable: false }],
    ["non-project scope", { scope: "DELIVERY_UNIT" as const }],
    [
      "unapproved current version",
      { retrospective: { ...base.retrospective, status: "IN_REVIEW" } }
    ],
    ["draft supersedes approved", { currentVersionId: "retrospective-v2" }],
    [
      "non-independent review",
      { retrospective: { ...base.retrospective, independentReviewer: false } }
    ],
    [
      "incomplete contribution",
      { retrospective: { ...base.retrospective, requiredContributionsComplete: false } }
    ],
    [
      "legacy archive A",
      { archiveA: { ...base.archiveA, archiveSourceFormulaVersion: "ARCHIVE.SOURCE@1" } }
    ],
    ["Archive A not ready", { archiveA: { ...base.archiveA, status: "FAILED" } }],
    ["Archive B not ready", { archiveB: { ...base.archiveB, status: "FAILED" } }],
    [
      "Archive B integrity fails",
      {
        archiveB: {
          ...base.archiveB,
          latestIntegrityCheck: { id: "integrity-b", status: "FAILED" }
        }
      }
    ],
    [
      "Archive B currentness is stale",
      { archiveB: { ...base.archiveB, sourceFactsCurrent: false } }
    ],
    [
      "B input changes",
      { archiveB: { ...base.archiveB, retrospectiveInputWatermark: "z".repeat(64) } }
    ],
    [
      "B omits approved version",
      { archiveB: { ...base.archiveB, includesRetrospectiveVersion: false } }
    ]
  ])("hard fails %s", (_label, override) => {
    expect(evaluateProjectRetrospectiveGate({ ...base, ...override })).toMatchObject({
      status: "HARD_FAILED"
    });
  });
});
