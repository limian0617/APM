import { describe, expect, it, vi } from "vitest";

import { readClosureGateFacts } from "./closure-gate-facts-reader";

function clientFixture() {
  const archiveA = {
    id: "archive-a",
    status: "READY",
    archiveSourceFormulaVersion: "V2",
    retrospectiveInputApplicability: "APPLICABLE",
    retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
    retrospectiveInputWatermark: "a".repeat(64),
    manifestChecksum: "b".repeat(64),
    sourceWatermark: "c".repeat(64)
  };
  const archiveB = {
    id: "archive-b",
    status: "READY",
    archiveSourceFormulaVersion: "V2",
    retrospectiveInputApplicability: "APPLICABLE",
    retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
    retrospectiveInputWatermark: "a".repeat(64),
    manifestChecksum: "d".repeat(64),
    sourceWatermark: "e".repeat(64),
    integrityChecks: [{ id: "integrity-b", status: "PASSED", sequence: 2 }],
    manifestItems: [{ sourceType: "PROJECT_RETROSPECTIVE_VERSION", sourceId: "retrospective-v1" }]
  };
  const retrospective = {
    currentVersionId: "retrospective-v1",
    latestApprovedVersionId: "retrospective-v1",
    currentVersion: {
      id: "retrospective-v1",
      status: "APPROVED",
      contentChecksum: "f".repeat(64),
      submittedById: "submitter-1",
      retrospectiveInputArchiveVersionId: "archive-a",
      retrospectiveInputManifestChecksum: "b".repeat(64),
      retrospectiveInputSourceWatermark: "c".repeat(64),
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputWatermark: "a".repeat(64),
      reviews: [{ decision: "APPROVED", reviewerId: "reviewer-1" }],
      contributions: [{ required: true, factText: "事实", impactText: "影响" }]
    }
  };
  return {
    projectArchiveVersion: {
      findMany: vi.fn().mockResolvedValue([archiveB]),
      findFirst: vi.fn().mockResolvedValue(archiveA)
    },
    projectRetrospective: { findUnique: vi.fn().mockResolvedValue(retrospective) },
    residualItem: { findMany: vi.fn().mockResolvedValue([]) },
    projectArchive: { findUnique: vi.fn().mockResolvedValue(null) },
    gateSubmission: { findMany: vi.fn().mockResolvedValue([]) }
  };
}

describe("closure Gate facts reader", () => {
  it("freezes Archive B, exact Archive A, approved current retrospective, latest PASSED integrity, and formula-current sources", async () => {
    const client = clientFixture();
    const facts = await readClosureGateFacts({
      projectId: "project-1",
      client,
      readCurrentSourceWatermark: vi.fn().mockResolvedValue("e".repeat(64))
    });

    expect(facts.closureArchiveV2).toMatchObject({
      factsAvailable: true,
      archiveA: { id: "archive-a", archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2" },
      archiveB: {
        id: "archive-b",
        status: "READY",
        latestIntegrityCheck: { id: "integrity-b", status: "PASSED" },
        sourceFactsCurrent: true
      },
      approvedRetrospective: { id: "retrospective-v1", status: "APPROVED" },
      archiveBIncludesRetrospectiveVersion: true
    });
    expect(facts.closureRetrospective).toMatchObject({
      factsAvailable: true,
      currentVersionId: "retrospective-v1",
      latestApprovedVersionId: "retrospective-v1",
      retrospective: { independentReviewer: true, requiredContributionsComplete: true }
    });
  });

  it("fails closed when no suitable Archive B exists or current V2 sources cannot be calculated", async () => {
    const noB = clientFixture();
    noB.projectArchiveVersion.findMany.mockResolvedValue([]);
    await expect(
      readClosureGateFacts({
        projectId: "project-1",
        client: noB,
        readCurrentSourceWatermark: vi.fn()
      })
    ).resolves.toMatchObject({ closureArchiveV2: { factsAvailable: false } });

    const unavailable = clientFixture();
    await expect(
      readClosureGateFacts({
        projectId: "project-1",
        client: unavailable,
        readCurrentSourceWatermark: vi.fn().mockRejectedValue(new Error("unavailable"))
      })
    ).resolves.toMatchObject({
      closureArchiveV2: { archiveB: { sourceFactsCurrent: false } }
    });
  });
});
