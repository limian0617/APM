import { describe, expect, it, vi } from "vitest";

import {
  CLOSURE_POLICY_BINDINGS,
  buildClosurePolicyVersionFacts
} from "@/modules/governance/domain/project-closure-policy";

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
      retrospectiveInputManifestChecksum: "a".repeat(64),
      retrospectiveInputSourceWatermark: "b".repeat(64),
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputWatermark: "i".repeat(64),
      status: "APPROVED"
    };
    const archiveA = {
      id: "archive-a",
      version: 1,
      status: "READY",
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE",
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputWatermark: "i".repeat(64),
      manifestChecksum: "a".repeat(64),
      sourceWatermark: "b".repeat(64),
      integrityChecks: [{ sequence: 1, status: "PASSED" }]
    };
    const archiveB = {
      id: "archive-b",
      version: 2,
      status: "READY",
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE",
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputWatermark: "i".repeat(64),
      manifestChecksum: "c".repeat(64),
      sourceWatermark: "d".repeat(64),
      integrityChecks: [{ sequence: 2, status: "PASSED" }],
      manifestItems: [{ sourceType: "PROJECT_RETROSPECTIVE_VERSION", sourceId: "version-2" }]
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
        findMany: vi
          .fn()
          .mockImplementation(async (input: any) =>
            input.where.id === "archive-a" ? [archiveA] : [archiveB]
          )
      },
      projectClosurePolicy: { findUnique: vi.fn().mockResolvedValue(null) }
    };

    const result = await getProjectRetrospective({
      projectId: "project-1",
      client: db as any,
      readCurrentV2Manifest: vi.fn().mockResolvedValue({
        manifestChecksum: archiveB.manifestChecksum,
        sourceWatermark: archiveB.sourceWatermark
      })
    });

    expect(result).toMatchObject({
      archiveA: { id: "archive-a" },
      archiveB: { id: "archive-b" },
      closurePolicy: null
    });
    expect(db.projectArchiveVersion.findMany).toHaveBeenCalledWith(
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
            retrospectiveInputManifestChecksum: "a".repeat(64),
            retrospectiveInputSourceWatermark: "b".repeat(64),
            retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
            retrospectiveInputWatermark: "i".repeat(64),
            status: "APPROVED"
          },
          versions: [],
          reviews: []
        })
      },
      projectArchiveVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "approved-archive",
            status: "READY",
            archiveSourceFormulaVersion: "V2",
            retrospectiveInputApplicability: "APPLICABLE",
            retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
            retrospectiveInputWatermark: "i".repeat(64),
            manifestChecksum: "a".repeat(64),
            sourceWatermark: "b".repeat(64),
            integrityChecks: [{ sequence: 1, status: "PASSED" }]
          }
        ])
      },
      projectClosurePolicy: { findUnique: vi.fn().mockResolvedValue(null) }
    };

    const result = await getProjectRetrospective({ projectId: "project-1", client: db as any });

    expect(result.archiveA).toMatchObject({ id: "approved-archive", status: "READY" });
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
    ).resolves.toMatchObject({
      projectId: "project-1",
      retrospective: null,
      currentVersion: null,
      latestApprovedVersion: null,
      archiveA: null,
      archiveB: null,
      closurePolicy: null,
      g9Approval: null,
      versions: [],
      allowedActions: []
    });
  });

  it("does not resolve Archive B when the current V2 manifest changed after a non-G9 source update", async () => {
    const approved = {
      id: "retrospective-v1",
      retrospectiveId: "retrospective-1",
      status: "APPROVED",
      retrospectiveInputArchiveVersionId: "archive-a",
      retrospectiveInputManifestChecksum: "a".repeat(64),
      retrospectiveInputSourceWatermark: "b".repeat(64),
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputWatermark: "i".repeat(64)
    };
    const db = {
      projectRetrospective: {
        findUnique: vi.fn().mockResolvedValue({
          id: "retrospective-1",
          projectId: "project-1",
          version: 1,
          currentVersionId: approved.id,
          latestApprovedVersionId: approved.id,
          currentVersion: approved,
          latestApprovedVersion: approved,
          versions: [approved],
          reviews: []
        })
      },
      projectArchiveVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "archive-a",
            status: "READY",
            archiveSourceFormulaVersion: "V2",
            retrospectiveInputApplicability: "APPLICABLE",
            retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
            retrospectiveInputWatermark: "i".repeat(64),
            manifestChecksum: "a".repeat(64),
            sourceWatermark: "b".repeat(64),
            integrityChecks: [{ sequence: 1, status: "PASSED" }]
          },
          {
            id: "archive-b",
            status: "READY",
            archiveSourceFormulaVersion: "V2",
            retrospectiveInputApplicability: "APPLICABLE",
            retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
            retrospectiveInputWatermark: "i".repeat(64),
            manifestChecksum: "c".repeat(64),
            sourceWatermark: "d".repeat(64),
            integrityChecks: [{ sequence: 2, status: "PASSED" }],
            manifestItems: [{ sourceType: "PROJECT_RETROSPECTIVE_VERSION", sourceId: approved.id }]
          }
        ])
      },
      projectClosurePolicy: { findUnique: vi.fn().mockResolvedValue(null) }
    };

    const result = await getProjectRetrospective({
      projectId: "project-1",
      client: db as any,
      readCurrentV2Manifest: vi.fn().mockResolvedValue({
        manifestChecksum: "e".repeat(64),
        sourceWatermark: "f".repeat(64)
      })
    } as any);

    expect(result.archiveB).toBeNull();
  });

  it("returns the exact current Archive A when no retrospective aggregate exists", async () => {
    const db = {
      projectRetrospective: { findUnique: vi.fn().mockResolvedValue(null) },
      projectArchiveVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "archive-a-current",
            status: "READY",
            archiveSourceFormulaVersion: "V2",
            retrospectiveInputApplicability: "APPLICABLE",
            manifestChecksum: "a".repeat(64),
            sourceWatermark: "b".repeat(64),
            integrityChecks: [{ sequence: 1, status: "PASSED" }]
          }
        ])
      },
      projectClosurePolicy: { findUnique: vi.fn().mockResolvedValue(null) }
    };

    const result = await getProjectRetrospective({
      projectId: "project-1",
      client: db as any,
      readCurrentV2Manifest: vi.fn().mockResolvedValue({
        manifestChecksum: "a".repeat(64),
        sourceWatermark: "b".repeat(64)
      })
    } as any);

    expect(result).toMatchObject({
      retrospective: null,
      archiveA: { id: "archive-a-current", status: "READY" },
      currentVersion: null,
      latestApprovedVersion: null,
      archiveB: null,
      closurePolicy: null,
      g9Approval: null
    });
  });

  it("fails closed for an active policy whose self-reference exclusion binding is not frozen", async () => {
    const version = {
      id: "retrospective-v1",
      retrospectiveId: "retrospective-1",
      status: "APPROVED",
      retrospectiveInputArchiveVersionId: "archive-a",
      retrospectiveInputManifestChecksum: "a".repeat(64),
      retrospectiveInputSourceWatermark: "b".repeat(64)
    };
    const db = {
      projectRetrospective: {
        findUnique: vi.fn().mockResolvedValue({
          id: "retrospective-1",
          projectId: "project-1",
          version: 1,
          currentVersionId: version.id,
          latestApprovedVersionId: version.id,
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
          manifestChecksum: "a".repeat(64),
          sourceWatermark: "b".repeat(64),
          integrityChecks: [{ sequence: 1, status: "PASSED" }]
        }),
        findFirst: vi.fn().mockResolvedValue(null)
      },
      projectClosurePolicy: {
        findUnique: vi.fn().mockResolvedValue({
          status: "ACTIVE",
          currentVersionId: "policy-v2",
          currentVersion: {
            id: "policy-v2",
            status: "ACTIVE",
            sourceTemplateSnapshotId: "snapshot-1",
            sourceGateDefinitionId: "g9-v2",
            archiveCheckerCode: "CLOSURE.ARCHIVE.G9",
            archiveCheckerVersion: 2,
            retrospectiveCheckerCode: "CLOSURE.RETROSPECTIVE.G9",
            retrospectiveCheckerVersion: 1,
            archiveSourceFormulaVersion: "V2",
            selfReferenceExclusionVersion: "wrong",
            bindingChecksum: "a".repeat(64),
            policyChecksum: "b".repeat(64),
            sourceGateDefinition: {
              id: "g9-v2",
              code: "G9",
              scope: "PROJECT",
              checkerBindingsJson: [
                { code: "CLOSURE.ARCHIVE.G9", version: 2 },
                { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
              ]
            },
            sourceTemplateSnapshot: { id: "snapshot-1", projectId: "project-1" }
          }
        })
      }
    };

    const result = await getProjectRetrospective({ projectId: "project-1", client: db as any });

    expect(result.closurePolicy).toBeNull();
  });

  it("exposes G9 approval only when the exact policy, archive, retrospective and checker evidence match", async () => {
    const policyFacts = buildClosurePolicyVersionFacts({
      projectId: "project-1",
      sourceTemplateSnapshotId: "snapshot-1",
      sourceGateDefinitionId: "g9-v2",
      checkerBindings: [...CLOSURE_POLICY_BINDINGS]
    });
    const approved = {
      id: "retrospective-v1",
      retrospectiveId: "retrospective-1",
      status: "APPROVED",
      contentChecksum: "c".repeat(64),
      retrospectiveInputArchiveVersionId: "archive-a",
      retrospectiveInputManifestChecksum: "a".repeat(64),
      retrospectiveInputSourceWatermark: "b".repeat(64),
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputWatermark: "i".repeat(64)
    };
    const policy = {
      id: "policy-1",
      projectId: "project-1",
      status: "ACTIVE",
      currentVersionId: "policy-v2",
      currentVersion: {
        id: "policy-v2",
        status: "ACTIVE",
        ...policyFacts,
        archiveSourceFormulaVersion: "V2",
        sourceGateDefinition: {
          id: "g9-v2",
          projectId: "project-1",
          code: "G9",
          scope: "PROJECT",
          checkerBindingsJson: [...CLOSURE_POLICY_BINDINGS]
        },
        sourceTemplateSnapshot: { id: "snapshot-1", projectId: "project-1" }
      }
    };
    const archiveB = {
      id: "archive-b",
      status: "READY",
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE",
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputWatermark: "i".repeat(64),
      manifestChecksum: "d".repeat(64),
      sourceWatermark: "e".repeat(64),
      integrityChecks: [{ id: "integrity-b", sequence: 2, status: "PASSED" }],
      manifestItems: [{ sourceType: "PROJECT_RETROSPECTIVE_VERSION", sourceId: approved.id }]
    };
    const archiveA = {
      id: "archive-a",
      status: "READY",
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE",
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputWatermark: "i".repeat(64),
      manifestChecksum: "a".repeat(64),
      sourceWatermark: "b".repeat(64),
      integrityChecks: [{ id: "integrity-a", sequence: 1, status: "PASSED" }]
    };
    const evidence = {
      projectId: "project-1",
      archiveAId: archiveA.id,
      archiveBId: archiveB.id,
      archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
      archiveAInputWatermark: archiveA.retrospectiveInputWatermark,
      archiveBInputWatermark: archiveB.retrospectiveInputWatermark,
      manifestChecksum: archiveB.manifestChecksum,
      sourceWatermark: archiveB.sourceWatermark,
      retrospectiveVersionId: approved.id,
      retrospectiveContentChecksum: approved.contentChecksum,
      currentVersionId: approved.id,
      currentRetrospectiveVersionId: approved.id,
      latestApprovedVersionId: approved.id,
      latestApprovedRetrospectiveVersionId: approved.id,
      archiveBIncludesRetrospectiveVersion: true,
      sourceFactsCurrent: true
    };
    const submission = {
      id: "g9-submission",
      projectId: "project-1",
      status: "APPROVED",
      closurePolicyVersionId: policy.currentVersion.id,
      closurePolicyChecksum: policy.currentVersion.policyChecksum,
      archiveSourceFormulaVersion: "V2",
      gateInstance: {
        id: "g9-instance",
        projectId: "project-1",
        gateDefinitionId: "g9-v2",
        closurePolicyVersionId: policy.currentVersion.id,
        closurePolicyChecksum: policy.currentVersion.policyChecksum,
        archiveSourceFormulaVersion: "V2",
        gateDefinition: policy.currentVersion.sourceGateDefinition
      },
      gateCheckSnapshot: {
        id: "g9-snapshot",
        projectId: "project-1",
        status: "PASSED",
        closurePolicyVersionId: policy.currentVersion.id,
        closurePolicyChecksum: policy.currentVersion.policyChecksum,
        archiveSourceFormulaVersion: "V2",
        checkerBindingsJson: [...CLOSURE_POLICY_BINDINGS],
        results: [
          {
            checkerCode: "CLOSURE.ARCHIVE.G9",
            checkerVersion: 2,
            status: "PASSED",
            evidenceJson: evidence
          },
          {
            checkerCode: "CLOSURE.RETROSPECTIVE.G9",
            checkerVersion: 1,
            status: "PASSED",
            evidenceJson: evidence
          }
        ]
      }
    };
    const baseClient = {
      projectRetrospective: {
        findUnique: vi.fn().mockResolvedValue({
          id: "retrospective-1",
          projectId: "project-1",
          version: 1,
          currentVersionId: approved.id,
          latestApprovedVersionId: approved.id,
          currentVersion: approved,
          latestApprovedVersion: approved,
          versions: [approved],
          reviews: []
        })
      },
      projectArchiveVersion: {
        findMany: vi
          .fn()
          .mockImplementation(async (input: any) =>
            input.where.id === archiveA.id ? [archiveA] : [archiveB]
          )
      },
      projectClosurePolicy: { findUnique: vi.fn().mockResolvedValue(policy) },
      gateSubmission: { findMany: vi.fn().mockResolvedValue([submission]) }
    };

    const result = await getProjectRetrospective({
      projectId: "project-1",
      client: baseClient as any,
      readCurrentV2Manifest: vi.fn().mockResolvedValue({
        manifestChecksum: archiveB.manifestChecksum,
        sourceWatermark: archiveB.sourceWatermark
      })
    } as any);

    expect(result.g9Approval).toMatchObject({
      submissionId: submission.id,
      status: "APPROVED"
    });

    for (const mutation of [
      { status: "PENDING" },
      { status: "APPROVED", gateCheckSnapshot: { ...submission.gateCheckSnapshot, results: [] } },
      {
        status: "APPROVED",
        gateCheckSnapshot: {
          ...submission.gateCheckSnapshot,
          results: submission.gateCheckSnapshot.results.map((item) => ({
            ...item,
            evidenceJson: { ...evidence, manifestChecksum: "f".repeat(64) }
          }))
        }
      }
    ]) {
      const mutatedClient = {
        ...baseClient,
        gateSubmission: { findMany: vi.fn().mockResolvedValue([{ ...submission, ...mutation }]) }
      };
      const mutated = await getProjectRetrospective({
        projectId: "project-1",
        client: mutatedClient as any,
        readCurrentV2Manifest: vi.fn().mockResolvedValue({
          manifestChecksum: archiveB.manifestChecksum,
          sourceWatermark: archiveB.sourceWatermark
        })
      } as any);
      expect(mutated.g9Approval).toBeNull();
    }
  });

  it("uses a draft Archive A only when there is no approved pointer", async () => {
    const draft = {
      id: "retrospective-draft",
      retrospectiveId: "retrospective-1",
      status: "DRAFT",
      retrospectiveInputArchiveVersionId: "draft-archive",
      retrospectiveInputManifestChecksum: "a".repeat(64),
      retrospectiveInputSourceWatermark: "b".repeat(64),
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputWatermark: "i".repeat(64)
    };
    const db = {
      projectRetrospective: {
        findUnique: vi.fn().mockResolvedValue({
          id: "retrospective-1",
          projectId: "project-1",
          version: 2,
          currentVersionId: draft.id,
          latestApprovedVersionId: null,
          currentVersion: draft,
          latestApprovedVersion: null,
          versions: [draft],
          reviews: []
        })
      },
      projectArchiveVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "draft-archive",
            status: "READY",
            archiveSourceFormulaVersion: "V2",
            retrospectiveInputApplicability: "APPLICABLE",
            retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
            retrospectiveInputWatermark: "i".repeat(64),
            manifestChecksum: "a".repeat(64),
            sourceWatermark: "b".repeat(64),
            integrityChecks: [{ sequence: 1, status: "PASSED" }]
          }
        ])
      },
      projectClosurePolicy: { findUnique: vi.fn().mockResolvedValue(null) }
    };
    const result = await getProjectRetrospective({
      projectId: "project-1",
      client: db as any,
      readCurrentV2Manifest: vi.fn().mockResolvedValue({
        manifestChecksum: "a".repeat(64),
        sourceWatermark: "b".repeat(64)
      })
    } as any);
    expect(result.archiveA).toMatchObject({ id: "draft-archive", status: "READY" });
  });

  it("chooses the newest deterministically ordered current Archive B rather than a bare first result", async () => {
    const approved = {
      id: "retrospective-v1",
      retrospectiveId: "retrospective-1",
      status: "APPROVED",
      retrospectiveInputArchiveVersionId: "archive-a",
      retrospectiveInputManifestChecksum: "a".repeat(64),
      retrospectiveInputSourceWatermark: "b".repeat(64),
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputWatermark: "i".repeat(64)
    };
    const archiveA = {
      id: "archive-a",
      version: 1,
      status: "READY",
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE",
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputWatermark: "i".repeat(64),
      manifestChecksum: "a".repeat(64),
      sourceWatermark: "b".repeat(64),
      integrityChecks: [{ sequence: 1, status: "PASSED" }]
    };
    const currentManifest = { manifestChecksum: "c".repeat(64), sourceWatermark: "d".repeat(64) };
    const archiveB = (id: string, version: number) => ({
      id,
      version,
      status: "READY",
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE",
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputWatermark: "i".repeat(64),
      ...currentManifest,
      integrityChecks: [{ sequence: version, status: "PASSED" }],
      manifestItems: [{ sourceType: "PROJECT_RETROSPECTIVE_VERSION", sourceId: approved.id }]
    });
    const db = {
      projectRetrospective: {
        findUnique: vi.fn().mockResolvedValue({
          id: "retrospective-1",
          projectId: "project-1",
          version: 1,
          currentVersionId: approved.id,
          latestApprovedVersionId: approved.id,
          currentVersion: approved,
          latestApprovedVersion: approved,
          versions: [approved],
          reviews: []
        })
      },
      projectArchiveVersion: {
        findMany: vi
          .fn()
          .mockImplementation(async (input: { where: { id?: string } }) =>
            input.where.id === archiveA.id
              ? [archiveA]
              : [archiveB("archive-b-older", 2), archiveB("archive-b-newer", 3)]
          )
      },
      projectClosurePolicy: { findUnique: vi.fn().mockResolvedValue(null) }
    };

    const result = await getProjectRetrospective({
      projectId: "project-1",
      client: db as any,
      readCurrentV2Manifest: vi.fn().mockResolvedValue(currentManifest)
    });

    expect(result.archiveB).toEqual({ id: "archive-b-newer", status: "READY" });
  });

  it.each([
    {
      name: "source G9 checker bindings differ from the frozen policy",
      bindings: [{ code: "CLOSURE.ARCHIVE.G9", version: 2 }],
      bindingChecksum: null
    },
    {
      name: "persisted binding checksum differs from the frozen policy",
      bindings: [...CLOSURE_POLICY_BINDINGS],
      bindingChecksum: "f".repeat(64)
    }
  ])("fails closed when $name", async ({ bindings, bindingChecksum }) => {
    const facts = buildClosurePolicyVersionFacts({
      projectId: "project-1",
      sourceTemplateSnapshotId: "snapshot-1",
      sourceGateDefinitionId: "g9-v2",
      checkerBindings: [...CLOSURE_POLICY_BINDINGS]
    });
    const draft = {
      id: "retrospective-draft",
      retrospectiveId: "retrospective-1",
      status: "DRAFT",
      retrospectiveInputArchiveVersionId: "archive-a"
    };
    const db = {
      projectRetrospective: {
        findUnique: vi.fn().mockResolvedValue({
          id: "retrospective-1",
          projectId: "project-1",
          version: 1,
          currentVersionId: draft.id,
          latestApprovedVersionId: null,
          currentVersion: draft,
          latestApprovedVersion: null,
          versions: [draft],
          reviews: []
        })
      },
      projectArchiveVersion: { findMany: vi.fn().mockResolvedValue([]) },
      projectClosurePolicy: {
        findUnique: vi.fn().mockResolvedValue({
          projectId: "project-1",
          status: "ACTIVE",
          currentVersionId: "policy-v2",
          currentVersion: {
            id: "policy-v2",
            status: "ACTIVE",
            ...facts,
            bindingChecksum: bindingChecksum ?? facts.bindingChecksum,
            archiveSourceFormulaVersion: "V2",
            sourceGateDefinition: {
              id: "g9-v2",
              projectId: "project-1",
              code: "G9",
              scope: "PROJECT",
              checkerBindingsJson: bindings
            },
            sourceTemplateSnapshot: { id: "snapshot-1", projectId: "project-1" }
          }
        })
      }
    };

    const result = await getProjectRetrospective({
      projectId: "project-1",
      client: db as any,
      readCurrentV2Manifest: vi.fn().mockResolvedValue({
        manifestChecksum: "a".repeat(64),
        sourceWatermark: "b".repeat(64)
      })
    });

    expect(result.closurePolicy).toBeNull();
  });

  it.each([
    ["no candidate", []],
    [
      "failed integrity",
      [
        {
          id: "archive-a",
          status: "READY",
          archiveSourceFormulaVersion: "V2",
          retrospectiveInputApplicability: "APPLICABLE",
          manifestChecksum: "a".repeat(64),
          sourceWatermark: "b".repeat(64),
          integrityChecks: [{ sequence: 1, status: "FAILED" }]
        }
      ]
    ],
    [
      "stale manifest",
      [
        {
          id: "archive-a",
          status: "READY",
          archiveSourceFormulaVersion: "V2",
          retrospectiveInputApplicability: "APPLICABLE",
          manifestChecksum: "a".repeat(64),
          sourceWatermark: "b".repeat(64),
          integrityChecks: [{ sequence: 1, status: "PASSED" }]
        }
      ]
    ]
  ])(
    "does not expose Archive A without a current READY/PASSED candidate: %s",
    async (_, archives) => {
      const db = {
        projectRetrospective: { findUnique: vi.fn().mockResolvedValue(null) },
        projectArchiveVersion: { findMany: vi.fn().mockResolvedValue(archives) }
      };
      const result = await getProjectRetrospective({
        projectId: "project-1",
        client: db as any,
        readCurrentV2Manifest: vi.fn().mockResolvedValue({
          manifestChecksum: "stale manifest" === _ ? "c".repeat(64) : "a".repeat(64),
          sourceWatermark: "stale manifest" === _ ? "d".repeat(64) : "b".repeat(64)
        })
      });

      expect(result.archiveA).toBeNull();
    }
  );
});
