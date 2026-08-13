import { describe, expect, it } from "vitest";

import { assertProjectCanClose, ProjectCloseError } from "./project-close-service";

describe("project close contract", () => {
  it("rejects stale closure facts as a conflict", () => {
    expect(() =>
      assertProjectCanClose({
        projectId: "p1",
        projectStatus: "IN_PROGRESS",
        projectVersion: 3,
        expectedProjectVersion: 2,
        g9Approved: true,
        g9SubmissionProjectId: "p1",
        g9ArchiveVersionId: "av1",
        g9ClosurePolicyVersionId: "policy-1",
        g9ClosurePolicyChecksum: "c".repeat(64),
        g9ArchiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
        g9SnapshotStatus: "PASSED",
        archiveVersionId: "av1",
        archiveStatus: "READY",
        archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
        manifestChecksum: "m",
        g9ManifestChecksum: "m",
        sourceWatermark: "w",
        g9SourceWatermark: "w",
        sourceFactsCurrent: true,
        latestIntegrityStatus: "PASSED",
        archiveInputWatermark: "i",
        archiveInputApplicability: "APPLICABLE",
        g9ArchiveInputWatermark: "i",
        archiveAInputWatermark: "i",
        archiveAActualInputWatermark: "i",
        archiveAId: "archive-a",
        archiveAStatus: "READY",
        archiveAFormula: "ARCHIVE.SOURCE@2",
        archiveAInputApplicability: "APPLICABLE",
        retrospectiveInputArchiveVersionId: "archive-a",
        retrospectiveInputArchiveManifestChecksum: "archive-manifest",
        retrospectiveInputArchiveSourceWatermark: "archive-watermark",
        archiveAManifestChecksum: "archive-manifest",
        archiveASourceWatermark: "archive-watermark",
        policyVersionId: "policy-1",
        policyChecksum: "c".repeat(64),
        policyArchiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
        policyBindingsValid: true,
        policySourceGateDefinitionMatches: true,
        policyIsActive: true,
        policyIsCurrent: true,
        gateInstancePolicyVersionId: "policy-1",
        gateInstancePolicyChecksum: "c".repeat(64),
        gateInstanceArchiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
        gateSnapshotPolicyVersionId: "policy-1",
        gateSnapshotPolicyChecksum: "c".repeat(64),
        gateSnapshotArchiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
        archiveCheckerPassed: true,
        retrospectiveCheckerPassed: true,
        retrospectiveVersionId: "retro-1",
        retrospectiveStatus: "APPROVED",
        retrospectiveContentChecksum: "e".repeat(64),
        g9RetrospectiveContentChecksum: "e".repeat(64),
        currentRetrospectiveVersionId: "retro-1",
        latestApprovedRetrospectiveVersionId: "retro-1",
        archiveBIncludesRetrospectiveVersion: true,
        openResidualItemIds: []
      })
    ).toThrowError(
      expect.objectContaining({
        code: "PROJECT_VERSION_CONFLICT",
        status: 409
      } satisfies Partial<ProjectCloseError>)
    );
  });
});
