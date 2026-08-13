import { describe, expect, it, vi } from "vitest";

import { getProjectRetrospective } from "./project-retrospective-query-service";

describe("project retrospective query service", () => {
  it("returns immutable versions, pointers, reviews and allowed actions for the project", async () => {
    const db = {
      projectRetrospective: {
        findUnique: vi.fn().mockResolvedValue({
          id: "retrospective-1",
          projectId: "project-1",
          version: 3,
          currentVersionId: "version-2",
          latestApprovedVersionId: "version-1",
          currentVersion: {
            id: "version-2",
            retrospectiveId: "retrospective-1",
            versionNo: 2,
            status: "DRAFT",
            contentChecksum: "a".repeat(64)
          },
          latestApprovedVersion: {
            id: "version-1",
            retrospectiveId: "retrospective-1",
            versionNo: 1,
            status: "APPROVED",
            contentChecksum: "b".repeat(64)
          },
          versions: [
            { id: "version-2", versionNo: 2, status: "DRAFT", contentChecksum: "a".repeat(64) },
            { id: "version-1", versionNo: 1, status: "APPROVED", contentChecksum: "b".repeat(64) }
          ],
          reviews: [{ id: "review-1", retrospectiveVersionId: "version-1", decision: "APPROVED" }]
        })
      },
      projectArchiveVersion: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null)
      },
      projectClosurePolicy: { findUnique: vi.fn().mockResolvedValue(null) }
    };

    await expect(
      getProjectRetrospective({ projectId: "project-1", client: db as any })
    ).resolves.toEqual(
      expect.objectContaining({
        projectId: "project-1",
        currentVersionId: "version-2",
        latestApprovedVersionId: "version-1",
        staleApprovedPointer: true,
        versions: expect.arrayContaining([
          expect.objectContaining({ id: "version-2", status: "DRAFT" })
        ])
      })
    );
    expect(db.projectRetrospective.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({ currentVersion: true, latestApprovedVersion: true })
      })
    );
  });

  it("fails closed when a frozen current pointer cannot be resolved", async () => {
    const db = {
      projectRetrospective: {
        findUnique: vi.fn().mockResolvedValue({
          id: "retrospective-1",
          projectId: "project-1",
          version: 3,
          currentVersionId: "missing-current",
          latestApprovedVersionId: "version-1",
          currentVersion: null,
          latestApprovedVersion: { id: "version-1", status: "APPROVED" },
          versions: [],
          reviews: []
        })
      }
    };

    await expect(
      getProjectRetrospective({ projectId: "project-1", client: db as any })
    ).rejects.toThrow("PROJECT_RETROSPECTIVE_POINTER_INVALID");
  });

  it("resolves archive A, archive B and V2 closure policy from frozen pointers", async () => {
    const currentVersion = {
      id: "version-2",
      retrospectiveId: "retrospective-1",
      retrospectiveInputArchiveVersionId: "archive-a",
      status: "APPROVED"
    };
    const db = {
      projectRetrospective: {
        findUnique: vi.fn().mockResolvedValue({
          id: "retrospective-1",
          projectId: "project-1",
          version: 2,
          currentVersionId: "version-2",
          latestApprovedVersionId: "version-2",
          currentVersion,
          latestApprovedVersion: currentVersion,
          versions: [currentVersion],
          reviews: []
        })
      },
      projectArchiveVersion: {
        findUnique: vi.fn().mockResolvedValue({
          id: "archive-a",
          status: "READY",
          archiveSourceFormulaVersion: "V2",
          retrospectiveInputApplicability: "APPLICABLE",
          integrityChecks: [{ status: "PASSED" }]
        }),
        findFirst: vi.fn().mockResolvedValue({
          id: "archive-b",
          status: "READY",
          archiveSourceFormulaVersion: "V2",
          retrospectiveInputApplicability: "APPLICABLE",
          integrityChecks: [{ status: "PASSED" }]
        })
      },
      projectClosurePolicy: {
        findUnique: vi.fn().mockResolvedValue({
          id: "policy-1",
          status: "ACTIVE",
          currentVersionId: "policy-version-2",
          currentVersion: {
            id: "policy-version-2",
            status: "ACTIVE",
            archiveCheckerCode: "CLOSURE.ARCHIVE.G9",
            archiveCheckerVersion: 2,
            retrospectiveCheckerCode: "CLOSURE.RETROSPECTIVE.G9",
            retrospectiveCheckerVersion: 1,
            archiveSourceFormulaVersion: "V2",
            sourceGateDefinition: { code: "G9", scope: "PROJECT" },
            sourceTemplateSnapshot: { id: "snapshot-1" }
          }
        })
      }
    };

    const result = await getProjectRetrospective({ projectId: "project-1", client: db as any });

    expect(result).toMatchObject({
      archiveA: { id: "archive-a" },
      archiveB: { id: "archive-b" },
      closurePolicy: { id: "policy-version-2", status: "ACTIVE" }
    });
    expect(db.projectArchiveVersion.findUnique).toHaveBeenCalledWith({
      where: { id_projectId: { id: "archive-a", projectId: "project-1" } },
      select: expect.any(Object)
    });
    expect(db.projectArchiveVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "project-1",
          archiveSourceFormulaVersion: "V2",
          manifestItems: {
            some: { sourceType: "PROJECT_RETROSPECTIVE_VERSION", sourceId: "version-2" }
          }
        })
      })
    );
  });

  it("fails closed when a pointer belongs to another retrospective or policy is not V2", async () => {
    const db = {
      projectRetrospective: {
        findUnique: vi.fn().mockResolvedValue({
          id: "retrospective-1",
          projectId: "project-1",
          version: 1,
          currentVersionId: "version-1",
          latestApprovedVersionId: "version-1",
          currentVersion: { id: "version-1", retrospectiveId: "other", status: "APPROVED" },
          latestApprovedVersion: { id: "version-1", retrospectiveId: "other", status: "APPROVED" },
          versions: [],
          reviews: []
        })
      }
    };

    await expect(
      getProjectRetrospective({ projectId: "project-1", client: db as any })
    ).rejects.toThrow("PROJECT_RETROSPECTIVE_POINTER_INVALID");
  });

  it("uses the approved frozen archive A rather than a newer stale draft", async () => {
    const db = {
      projectRetrospective: {
        findUnique: vi.fn().mockResolvedValue({
          id: "retrospective-1",
          projectId: "project-1",
          version: 3,
          currentVersionId: "draft-2",
          latestApprovedVersionId: "approved-1",
          currentVersion: {
            id: "draft-2",
            retrospectiveId: "retrospective-1",
            retrospectiveInputArchiveVersionId: "draft-archive",
            status: "DRAFT"
          },
          latestApprovedVersion: {
            id: "approved-1",
            retrospectiveId: "retrospective-1",
            retrospectiveInputArchiveVersionId: "approved-archive",
            status: "APPROVED"
          },
          versions: [],
          reviews: []
        })
      },
      projectArchiveVersion: {
        findUnique: vi.fn().mockResolvedValue({ id: "approved-archive", status: "READY" }),
        findFirst: vi.fn().mockResolvedValue(null)
      },
      projectClosurePolicy: { findUnique: vi.fn().mockResolvedValue(null) }
    };

    await getProjectRetrospective({ projectId: "project-1", client: db as any });

    expect(db.projectArchiveVersion.findUnique).toHaveBeenCalledWith({
      where: { id_projectId: { id: "approved-archive", projectId: "project-1" } },
      select: expect.any(Object)
    });
  });

  it("does not expose a READY archive or active policy as executable when frozen integrity or V2 source facts mismatch", async () => {
    const version = {
      id: "version-1",
      retrospectiveId: "retrospective-1",
      retrospectiveInputArchiveVersionId: "archive-a",
      status: "APPROVED"
    };
    const db = {
      projectRetrospective: {
        findUnique: vi.fn().mockResolvedValue({
          id: "retrospective-1",
          projectId: "project-1",
          version: 1,
          currentVersionId: "version-1",
          latestApprovedVersionId: "version-1",
          currentVersion: version,
          latestApprovedVersion: version,
          versions: [version],
          reviews: []
        })
      },
      projectArchiveVersion: {
        findUnique: vi.fn().mockResolvedValue({
          id: "archive-a",
          status: "READY",
          archiveSourceFormulaVersion: "V2",
          retrospectiveInputApplicability: "APPLICABLE",
          integrityChecks: [{ status: "FAILED" }]
        }),
        findFirst: vi.fn().mockResolvedValue(null)
      },
      projectClosurePolicy: {
        findUnique: vi.fn().mockResolvedValue({
          id: "policy-1",
          status: "ACTIVE",
          currentVersionId: "policy-version-1",
          currentVersion: {
            id: "policy-version-1",
            status: "ACTIVE",
            archiveCheckerCode: "CLOSURE.ARCHIVE.G9",
            archiveCheckerVersion: 1,
            retrospectiveCheckerCode: "CLOSURE.RETROSPECTIVE.G9",
            retrospectiveCheckerVersion: 1,
            archiveSourceFormulaVersion: "V1",
            sourceGateDefinition: { code: "G9", revision: 1, scope: "PROJECT" },
            sourceTemplateSnapshot: { id: "snapshot" }
          }
        })
      }
    };

    const result = await getProjectRetrospective({ projectId: "project-1", client: db as any });

    expect(result.archiveA).toBeNull();
    expect(result.closurePolicy).toBeNull();
  });

  it("returns empty when the project has no retrospective aggregate", async () => {
    const db = { projectRetrospective: { findUnique: vi.fn().mockResolvedValue(null) } };
    await expect(
      getProjectRetrospective({ projectId: "project-1", client: db as any })
    ).resolves.toEqual({
      projectId: "project-1",
      retrospective: null,
      versions: [],
      allowedActions: []
    });
  });
});
