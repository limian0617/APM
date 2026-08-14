import { beforeEach, describe, expect, it, vi } from "vitest";

import { payloadHash } from "@/modules/governance/domain/idempotency";

const { auditSpy, outboxSpy } = vi.hoisted(() => ({
  auditSpy: vi.fn(async () => ({ id: "audit-knowledge-1" })),
  outboxSpy: vi.fn(async () => ({ id: "outbox-knowledge-1" }))
}));

vi.mock("@/modules/audit/infrastructure/write-audit", () => ({ writeAudit: auditSpy }));
vi.mock("@/modules/governance/infrastructure/outbox", () => ({
  appendOutboxEvent: outboxSpy
}));

import {
  createKnowledgeEntryVersion,
  reviewKnowledgeEntryVersion,
  revokeKnowledgeEntryVersion,
  submitKnowledgeEntryVersion
} from "./knowledge-entry-service";

function knowledgeDraft() {
  return {
    title: "Servo jitter tuning",
    sanitizedSummary: "Stabilize servo tuning without customer identifiers.",
    experienceType: "COMMISSIONING",
    discipline: "ELECTRICAL",
    keywords: ["servo", "jitter"],
    applicableProjectTypes: ["CUSTOMER_DELIVERY"],
    applicableStageCodes: ["S5"],
    preconditions: "Baseline parameters are backed up.",
    recommendedPractice: "Tune one axis at a time and record the response.",
    antiPatterns: "Do not copy a customer's parameter file.",
    limitations: "Requires a stable no-load commissioning condition.",
    ipSanitizationDeclaration: "Customer names and parameter files were removed.",
    internalReusable: true
  };
}

function sourceProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "source-project-1",
    status: "CLOSED",
    finalArchiveVersionId: "archive-b-1",
    ...overrides
  };
}

function archive(overrides: Record<string, unknown> = {}) {
  return {
    id: "archive-a-1",
    projectId: "source-project-1",
    status: "READY",
    archiveSourceFormulaVersion: "V2",
    manifestChecksum: "a".repeat(64),
    sourceWatermark: "b".repeat(64),
    retrospectiveInputApplicability: "APPLICABLE",
    retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
    retrospectiveInputSnapshotJson: { formula: "RETROSPECTIVE.INPUT@1" },
    retrospectiveInputWatermark: "c".repeat(64),
    integrityChecks: [{ status: "PASSED", sequence: 2 }],
    ...overrides
  };
}

function retrospectiveVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: "retrospective-version-1",
    projectId: "source-project-1",
    retrospectiveId: "retrospective-1",
    versionNo: 3,
    status: "APPROVED",
    retrospectiveInputArchiveVersionId: "archive-a-1",
    retrospectiveInputManifestChecksum: "a".repeat(64),
    retrospectiveInputSourceWatermark: "b".repeat(64),
    retrospectiveInputWatermark: "c".repeat(64),
    contentChecksum: "d".repeat(64),
    retrospective: {
      id: "retrospective-1",
      projectId: "source-project-1",
      currentVersionId: "retrospective-version-1",
      latestApprovedVersionId: "retrospective-version-1"
    },
    ...overrides
  };
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn(async () => [{ now: transactionNow }]),
    project: { findUnique: vi.fn(async () => sourceProject()) },
    projectArchiveVersion: { findUnique: vi.fn() },
    projectRetrospectiveVersion: { findUnique: vi.fn() },
    projectArchiveManifestItem: { findFirst: vi.fn() },
    issueHistory: { findMany: vi.fn(async () => []) },
    knowledgeEntry: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    knowledgeEntryVersion: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn()
    },
    knowledgeEntrySource: { createMany: vi.fn(), findMany: vi.fn(async () => []) },
    knowledgeEntryReview: { create: vi.fn() },
    ...overrides
  } as any;
}

const command = {
  code: "KNOW-001",
  sourceProjectId: "source-project-1",
  finalArchiveVersionId: "archive-b-1",
  retrospectiveInputArchiveVersionId: "archive-a-1",
  retrospectiveVersionId: "retrospective-version-1",
  issueHistoryIds: [],
  draft: knowledgeDraft(),
  actorId: "author-1",
  idempotencyKey: "knowledge-create-1",
  expectedEntryVersion: null,
  sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: true }
};

const transactionNow = new Date("2026-08-14T12:34:56.000Z");

beforeEach(() => {
  auditSpy.mockClear();
  outboxSpy.mockClear();
});

describe("knowledge entry service", () => {
  it("rejects a historical closed project that lacks an approved retrospective instead of creating legacy knowledge", async () => {
    const client = transaction({
      projectArchiveVersion: {
        findUnique: vi.fn(async ({ where }: { where: { id_projectId: { id: string } } }) =>
          where.id_projectId.id === "archive-a-1"
            ? archive()
            : archive({ id: "archive-b-1", status: "FINALIZED" })
        )
      },
      projectRetrospectiveVersion: { findUnique: vi.fn(async () => null) }
    });

    await expect(createKnowledgeEntryVersion(command, client)).rejects.toMatchObject({
      code: "KNOWLEDGE_APPROVED_RETROSPECTIVE_REQUIRED",
      status: 409
    });
    expect(client.knowledgeEntry.create).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("requires the source project to be CLOSED before reading archive or retrospective facts", async () => {
    const client = transaction({
      project: { findUnique: vi.fn(async () => sourceProject({ status: "IN_PROGRESS" })) }
    });

    await expect(createKnowledgeEntryVersion(command, client)).rejects.toMatchObject({
      code: "KNOWLEDGE_SOURCE_PROJECT_CLOSED_REQUIRED",
      status: 409
    });
    expect(client.projectArchiveVersion.findUnique).not.toHaveBeenCalled();
    expect(client.projectRetrospectiveVersion.findUnique).not.toHaveBeenCalled();
    expect(client.knowledgeEntry.create).not.toHaveBeenCalled();
  });

  it("requires both source-read grants before reading any source project fact", async () => {
    const client = transaction();

    await expect(
      createKnowledgeEntryVersion(
        {
          ...command,
          sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: false }
        },
        client
      )
    ).rejects.toMatchObject({ code: "KNOWLEDGE_SOURCE_READ_FORBIDDEN", status: 403 });
    expect(client.project.findUnique).not.toHaveBeenCalled();
  });

  it("requires the precise finalized Archive B and its latest passed integrity check", async () => {
    const client = transaction({
      projectArchiveVersion: {
        findUnique: vi.fn(async ({ where }: { where: { id_projectId: { id: string } } }) =>
          where.id_projectId.id === "archive-a-1"
            ? archive()
            : archive({
                id: "archive-b-1",
                status: "READY",
                integrityChecks: [{ status: "FAILED", sequence: 3 }]
              })
        )
      },
      projectRetrospectiveVersion: {
        findUnique: vi.fn(async () => retrospectiveVersion())
      }
    });

    await expect(createKnowledgeEntryVersion(command, client)).rejects.toMatchObject({
      code: "KNOWLEDGE_FINAL_ARCHIVE_NOT_FINALIZED",
      status: 409
    });
    expect(client.knowledgeEntry.create).not.toHaveBeenCalled();
  });

  it("rejects Archive A when its frozen retrospective input watermark is not applicable", async () => {
    const client = transaction({
      projectArchiveVersion: {
        findUnique: vi.fn(async ({ where }: { where: { id_projectId: { id: string } } }) =>
          where.id_projectId.id === "archive-a-1"
            ? archive({
                retrospectiveInputApplicability: "NOT_APPLICABLE",
                retrospectiveInputWatermarkVersion: null,
                retrospectiveInputSnapshotJson: null,
                retrospectiveInputWatermark: null
              })
            : archive({ id: "archive-b-1", status: "FINALIZED" })
        )
      },
      projectRetrospectiveVersion: { findUnique: vi.fn(async () => retrospectiveVersion()) }
    });

    await expect(createKnowledgeEntryVersion(command, client)).rejects.toMatchObject({
      code: "KNOWLEDGE_INPUT_ARCHIVE_NOT_READY",
      status: 409
    });
    expect(client.knowledgeEntry.create).not.toHaveBeenCalled();
  });

  it("rejects an approved retrospective whose frozen input watermark differs from Archive A", async () => {
    const client = transaction({
      projectArchiveVersion: {
        findUnique: vi.fn(async ({ where }: { where: { id_projectId: { id: string } } }) =>
          where.id_projectId.id === "archive-a-1"
            ? archive()
            : archive({ id: "archive-b-1", status: "FINALIZED" })
        )
      },
      projectRetrospectiveVersion: {
        findUnique: vi.fn(async () =>
          retrospectiveVersion({ retrospectiveInputWatermark: "f".repeat(64) })
        )
      }
    });

    await expect(createKnowledgeEntryVersion(command, client)).rejects.toMatchObject({
      code: "KNOWLEDGE_APPROVED_RETROSPECTIVE_REQUIRED",
      status: 409
    });
    expect(client.knowledgeEntry.create).not.toHaveBeenCalled();
  });

  it("rejects Archive B when its retrospective manifest snapshot is not the exact approved content", async () => {
    const client = transaction({
      projectArchiveVersion: {
        findUnique: vi.fn(async ({ where }: { where: { id_projectId: { id: string } } }) =>
          where.id_projectId.id === "archive-a-1"
            ? archive()
            : archive({ id: "archive-b-1", status: "FINALIZED" })
        )
      },
      projectRetrospectiveVersion: { findUnique: vi.fn(async () => retrospectiveVersion()) },
      projectArchiveManifestItem: {
        findFirst: vi.fn(async () => ({
          sourceChecksum: "d".repeat(64),
          snapshotJson: {
            retrospectiveInputArchiveVersionId: "archive-a-1",
            retrospectiveInputWatermark: "c".repeat(64),
            contentChecksum: "e".repeat(64)
          }
        }))
      }
    });

    await expect(createKnowledgeEntryVersion(command, client)).rejects.toMatchObject({
      code: "KNOWLEDGE_FINAL_ARCHIVE_RETROSPECTIVE_MISMATCH",
      status: 409
    });
    expect(client.knowledgeEntry.create).not.toHaveBeenCalled();
  });

  it("creates an immutable draft with exact archive/retrospective snapshots and no binary evidence", async () => {
    const client = transaction({
      projectArchiveVersion: {
        findUnique: vi.fn(async ({ where }: { where: { id_projectId: { id: string } } }) =>
          where.id_projectId.id === "archive-a-1"
            ? archive()
            : archive({ id: "archive-b-1", status: "FINALIZED" })
        )
      },
      projectRetrospectiveVersion: {
        findUnique: vi.fn(async () => retrospectiveVersion())
      },
      projectArchiveManifestItem: {
        findFirst: vi.fn(async () => ({
          id: "manifest-retro-1",
          projectId: "source-project-1",
          archiveVersionId: "archive-b-1",
          sourceType: "PROJECT_RETROSPECTIVE_VERSION",
          sourceId: "retrospective-version-1",
          sourceVersion: "3",
          sourceChecksum: "d".repeat(64),
          snapshotJson: {
            retrospectiveInputArchiveVersionId: "archive-a-1",
            retrospectiveInputWatermark: "c".repeat(64),
            contentChecksum: "d".repeat(64)
          },
          fileObjectId: "must-not-copy"
        }))
      },
      knowledgeEntry: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "knowledge-entry-1",
          version: 1,
          ...data
        }))
      },
      knowledgeEntryVersion: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "knowledge-version-1",
          ...data
        }))
      },
      knowledgeEntrySource: {
        createMany: vi.fn(async () => ({ count: 1 }))
      }
    });

    const result = await createKnowledgeEntryVersion(command, client);

    expect(result).toMatchObject({ status: "DRAFT", entryId: "knowledge-entry-1" });
    const versionCall = client.knowledgeEntryVersion.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(versionCall.data).toMatchObject({
      sourceProjectId: "source-project-1",
      normalizedKeywordsText: "jitter servo",
      status: "DRAFT"
    });
    expect(versionCall.data.contentChecksum).toMatch(/^[a-f0-9]{64}$/u);
    const sourceCall = client.knowledgeEntrySource.createMany.mock.calls[0]?.[0] as {
      data: Array<Record<string, unknown>>;
    };
    expect(sourceCall.data[0]).toMatchObject({
      sourceProjectId: "source-project-1",
      finalArchiveVersionId: "archive-b-1",
      retrospectiveInputArchiveVersionId: "archive-a-1",
      retrospectiveVersionId: "retrospective-version-1",
      finalArchiveFormula: "V2",
      retrospectiveInputFormula: "V2"
    });
    expect(sourceCall.data[0]).not.toHaveProperty("fileObjectId");
    expect(auditSpy).toHaveBeenCalled();
    expect(outboxSpy).toHaveBeenCalled();
  });

  it("freezes only controlled IssueHistory facts in a source snapshot and excludes sensitive evidence", async () => {
    const sensitiveSnapshot = {
      category: "PERFORMANCE",
      severity: "HIGH",
      status: "CLOSED",
      eventType: "CLOSED",
      confirmedText: "Customer Alpha's servo jittered at serial 001.",
      title: "Customer Alpha servo issue",
      phenomenonDescription: "Customer-only observation.",
      rootCauseDescription: "Confidential root cause.",
      verificationEvidence: "https://customer.example/evidence",
      sourceSnapshot: { customer: "Alpha" },
      ownerMembershipId: "member-secret",
      fileObjectId: "file-secret"
    };
    const client = transaction({
      projectArchiveVersion: {
        findUnique: vi.fn(async ({ where }: { where: { id_projectId: { id: string } } }) =>
          where.id_projectId.id === "archive-a-1"
            ? archive()
            : archive({ id: "archive-b-1", status: "FINALIZED" })
        )
      },
      projectRetrospectiveVersion: { findUnique: vi.fn(async () => retrospectiveVersion()) },
      projectArchiveManifestItem: {
        findFirst: vi.fn(async () => ({
          sourceChecksum: "d".repeat(64),
          snapshotJson: {
            retrospectiveInputArchiveVersionId: "archive-a-1",
            retrospectiveInputWatermark: "c".repeat(64),
            contentChecksum: "d".repeat(64)
          }
        }))
      },
      issueHistory: {
        findMany: vi.fn(async () => [
          {
            id: "issue-history-1",
            projectId: "source-project-1",
            issueId: "issue-1",
            sequence: 7,
            eventType: "CLOSED",
            snapshotJson: sensitiveSnapshot
          }
        ])
      },
      knowledgeEntry: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "knowledge-entry-1",
          version: 1,
          ...data
        }))
      },
      knowledgeEntryVersion: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "knowledge-version-1",
          ...data
        }))
      },
      knowledgeEntrySource: { createMany: vi.fn(async () => ({ count: 1 })) }
    });

    await createKnowledgeEntryVersion({ ...command, issueHistoryIds: ["issue-history-1"] }, client);

    const sourceCall = client.knowledgeEntrySource.createMany.mock.calls[0]?.[0] as {
      data: Array<Record<string, unknown>>;
    };
    const snapshot = sourceCall.data[0]?.sanitizedSnapshotJson as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      issueHistory: {
        issueId: "issue-1",
        issueHistoryId: "issue-history-1",
        sequence: 7,
        eventType: "CLOSED",
        category: "PERFORMANCE",
        severity: "HIGH",
        status: "CLOSED"
      }
    });
    const serialized = JSON.stringify(snapshot);
    for (const secret of [
      "Customer Alpha",
      "Customer Alpha servo issue",
      "Customer-only observation.",
      "Confidential root cause.",
      "customer.example",
      "member-secret",
      "file-secret"
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(sourceCall.data[0]?.sourceChecksum).toBe(payloadHash(snapshot).hash);
  });

  it("fails closed instead of hashing an IssueHistory snapshot without controlled classification facts", async () => {
    const client = transaction({
      projectArchiveVersion: {
        findUnique: vi.fn(async ({ where }: { where: { id_projectId: { id: string } } }) =>
          where.id_projectId.id === "archive-a-1"
            ? archive()
            : archive({ id: "archive-b-1", status: "FINALIZED" })
        )
      },
      projectRetrospectiveVersion: { findUnique: vi.fn(async () => retrospectiveVersion()) },
      projectArchiveManifestItem: {
        findFirst: vi.fn(async () => ({
          sourceChecksum: "d".repeat(64),
          snapshotJson: {
            retrospectiveInputArchiveVersionId: "archive-a-1",
            retrospectiveInputWatermark: "c".repeat(64),
            contentChecksum: "d".repeat(64)
          }
        }))
      },
      issueHistory: {
        findMany: vi.fn(async () => [
          {
            id: "issue-history-1",
            projectId: "source-project-1",
            issueId: "issue-1",
            sequence: 7,
            eventType: "CLOSED",
            snapshotJson: { category: "PERFORMANCE", severity: "NOT_A_SEVERITY" }
          }
        ])
      },
      knowledgeEntry: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "knowledge-entry-1",
          version: 1,
          ...data
        }))
      },
      knowledgeEntryVersion: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "knowledge-version-1",
          ...data
        }))
      },
      knowledgeEntrySource: { createMany: vi.fn(async () => ({ count: 1 })) }
    });

    await expect(
      createKnowledgeEntryVersion({ ...command, issueHistoryIds: ["issue-history-1"] }, client)
    ).rejects.toMatchObject({ code: "KNOWLEDGE_ISSUE_HISTORY_SNAPSHOT_INVALID", status: 409 });
    expect(client.knowledgeEntry.create).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("links a new draft to the exact previously published version instead of the newest mutable version", async () => {
    const client = transaction({
      projectArchiveVersion: {
        findUnique: vi.fn(async ({ where }: { where: { id_projectId: { id: string } } }) =>
          where.id_projectId.id === "archive-a-1"
            ? archive()
            : archive({ id: "archive-b-1", status: "FINALIZED" })
        )
      },
      projectRetrospectiveVersion: {
        findUnique: vi.fn(async () => retrospectiveVersion())
      },
      projectArchiveManifestItem: {
        findFirst: vi.fn(async () => ({
          sourceChecksum: "d".repeat(64),
          snapshotJson: {
            retrospectiveInputArchiveVersionId: "archive-a-1",
            retrospectiveInputWatermark: "c".repeat(64),
            contentChecksum: "d".repeat(64)
          }
        }))
      },
      knowledgeEntry: {
        findUnique: vi.fn(async () => ({
          id: "knowledge-entry-1",
          code: "KNOW-001",
          status: "ACTIVE",
          version: 7,
          currentPublishedVersionId: "knowledge-version-published-2"
        })),
        create: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      knowledgeEntryVersion: {
        findFirst: vi.fn(async () => ({ versionNo: 7 })),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "knowledge-version-8",
          ...data
        }))
      },
      knowledgeEntrySource: { createMany: vi.fn(async () => ({ count: 1 })) }
    });

    await createKnowledgeEntryVersion(
      { ...command, entryId: "knowledge-entry-1", expectedEntryVersion: 7 },
      client
    );

    expect(client.knowledgeEntryVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          versionNo: 8,
          supersedesVersionId: "knowledge-version-published-2"
        })
      })
    );
  });

  it("rejects a stale entry version before creating a follow-up immutable draft", async () => {
    const client = transaction({
      projectArchiveVersion: {
        findUnique: vi.fn(async ({ where }: { where: { id_projectId: { id: string } } }) =>
          where.id_projectId.id === "archive-a-1"
            ? archive()
            : archive({ id: "archive-b-1", status: "FINALIZED" })
        )
      },
      projectRetrospectiveVersion: { findUnique: vi.fn(async () => retrospectiveVersion()) },
      projectArchiveManifestItem: {
        findFirst: vi.fn(async () => ({
          sourceChecksum: "d".repeat(64),
          snapshotJson: {
            retrospectiveInputArchiveVersionId: "archive-a-1",
            retrospectiveInputWatermark: "c".repeat(64),
            contentChecksum: "d".repeat(64)
          }
        }))
      },
      knowledgeEntry: {
        findUnique: vi.fn(async () => ({
          id: "knowledge-entry-1",
          code: "KNOW-001",
          status: "ACTIVE",
          version: 7,
          currentPublishedVersionId: "knowledge-version-published-2"
        })),
        create: vi.fn(),
        updateMany: vi.fn()
      },
      knowledgeEntryVersion: {
        findFirst: vi.fn(async () => ({ versionNo: 7 })),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "knowledge-version-8",
          ...data
        }))
      },
      knowledgeEntrySource: { createMany: vi.fn(async () => ({ count: 1 })) }
    });

    await expect(
      createKnowledgeEntryVersion(
        { ...command, entryId: "knowledge-entry-1", expectedEntryVersion: 6 },
        client
      )
    ).rejects.toMatchObject({ code: "KNOWLEDGE_ENTRY_VERSION_CONFLICT", status: 409 });

    expect(client.knowledgeEntryVersion.create).not.toHaveBeenCalled();
    expect(client.knowledgeEntrySource.createMany).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("does not reopen a revoked knowledge entry through a new draft", async () => {
    const client = transaction({
      projectArchiveVersion: {
        findUnique: vi.fn(async ({ where }: { where: { id_projectId: { id: string } } }) =>
          where.id_projectId.id === "archive-a-1"
            ? archive()
            : archive({ id: "archive-b-1", status: "FINALIZED" })
        )
      },
      projectRetrospectiveVersion: { findUnique: vi.fn(async () => retrospectiveVersion()) },
      projectArchiveManifestItem: {
        findFirst: vi.fn(async () => ({
          sourceChecksum: "d".repeat(64),
          snapshotJson: {
            retrospectiveInputArchiveVersionId: "archive-a-1",
            retrospectiveInputWatermark: "c".repeat(64),
            contentChecksum: "d".repeat(64)
          }
        }))
      },
      knowledgeEntry: {
        findUnique: vi.fn(async () => ({
          id: "knowledge-entry-1",
          code: "KNOW-001",
          status: "REVOKED",
          version: 7,
          currentPublishedVersionId: null
        })),
        create: vi.fn(),
        updateMany: vi.fn()
      },
      knowledgeEntryVersion: {
        findFirst: vi.fn(async () => ({ versionNo: 7 })),
        create: vi.fn()
      },
      knowledgeEntrySource: { createMany: vi.fn() }
    });

    await expect(
      createKnowledgeEntryVersion(
        { ...command, entryId: "knowledge-entry-1", expectedEntryVersion: 7 },
        client
      )
    ).rejects.toMatchObject({ code: "KNOWLEDGE_ENTRY_REVOKED", status: 409 });

    expect(client.knowledgeEntry.updateMany).not.toHaveBeenCalled();
    expect(client.knowledgeEntryVersion.create).not.toHaveBeenCalled();
    expect(client.knowledgeEntrySource.createMany).not.toHaveBeenCalled();
  });

  it("rejects a revoked entry's legacy draft before it can be submitted", async () => {
    const client = transaction({
      knowledgeEntryVersion: {
        findUnique: vi.fn(async () => ({
          id: "knowledge-version-draft-1",
          entryId: "knowledge-entry-1",
          sourceProjectId: "source-project-1",
          status: "DRAFT",
          createdById: "author-1",
          entry: { id: "knowledge-entry-1", status: "REVOKED", version: 4 }
        })),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      knowledgeEntry: { updateMany: vi.fn(async () => ({ count: 1 })) }
    });

    await expect(
      submitKnowledgeEntryVersion(
        {
          entryId: "knowledge-entry-1",
          versionId: "knowledge-version-draft-1",
          expectedEntryVersion: 4,
          actorId: "author-1",
          idempotencyKey: "knowledge-submit-revoked-1",
          sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: true }
        },
        client
      )
    ).rejects.toMatchObject({ code: "KNOWLEDGE_ENTRY_REVOKED", status: 409 });
    expect(client.knowledgeEntryVersion.updateMany).not.toHaveBeenCalled();
    expect(client.knowledgeEntry.updateMany).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("submits only the current immutable draft version and writes audit/outbox facts", async () => {
    const client = transaction({
      knowledgeEntryVersion: {
        findUnique: vi.fn(async () => ({
          id: "knowledge-version-1",
          entryId: "knowledge-entry-1",
          sourceProjectId: "source-project-1",
          status: "DRAFT",
          createdById: "author-1",
          entry: { id: "knowledge-entry-1", status: "ACTIVE", version: 4 }
        })),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      knowledgeEntry: { updateMany: vi.fn(async () => ({ count: 1 })) }
    });

    const result = await submitKnowledgeEntryVersion(
      {
        entryId: "knowledge-entry-1",
        versionId: "knowledge-version-1",
        expectedEntryVersion: 4,
        actorId: "author-1",
        idempotencyKey: "knowledge-submit-1",
        sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: true }
      },
      client
    );

    expect(result).toMatchObject({ status: "IN_REVIEW" });
    expect(client.knowledgeEntryVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entry: { is: { status: "ACTIVE" } } }),
        data: expect.objectContaining({ status: "IN_REVIEW", submittedAt: transactionNow })
      })
    );
    expect(client.$queryRaw).toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalled();
    expect(outboxSpy).toHaveBeenCalled();
  });

  it("publishes only an independently reviewed and explicitly sanitized version", async () => {
    const client = transaction({
      knowledgeEntryVersion: {
        findUnique: vi.fn(async () => ({
          id: "knowledge-version-1",
          entryId: "knowledge-entry-1",
          sourceProjectId: "source-project-1",
          status: "IN_REVIEW",
          submittedById: "author-1",
          entry: {
            id: "knowledge-entry-1",
            status: "ACTIVE",
            version: 5,
            currentPublishedVersionId: null
          }
        })),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      knowledgeEntry: { updateMany: vi.fn(async () => ({ count: 1 })) },
      knowledgeEntrySource: {
        findMany: vi.fn(async () => [{ sourceChecksum: "e".repeat(64) }])
      },
      knowledgeEntryReview: { create: vi.fn(async () => ({ id: "review-1" })) }
    });

    const result = await reviewKnowledgeEntryVersion(
      {
        entryId: "knowledge-entry-1",
        versionId: "knowledge-version-1",
        expectedEntryVersion: 5,
        decision: "PUBLISH",
        reason: "Internal reusable and sanitized.",
        ipConfirmed: true,
        sanitizationConfirmed: true,
        actorId: "reviewer-1",
        idempotencyKey: "knowledge-review-1",
        sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: true }
      },
      client
    );

    expect(result).toMatchObject({ status: "PUBLISHED", entryId: "knowledge-entry-1" });
    expect(client.knowledgeEntryReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ipConfirmed: true, sanitizationConfirmed: true })
      })
    );
    expect(client.knowledgeEntryVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PUBLISHED" }) })
    );
    expect(client.knowledgeEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentPublishedVersionId: "knowledge-version-1" })
      })
    );
    const versionUpdate = client.knowledgeEntryVersion.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    const reviewCreate = client.knowledgeEntryReview.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(versionUpdate.data.publishedAt).toBe(transactionNow);
    expect(reviewCreate.data.reviewedAt).toBe(transactionNow);
    expect(versionUpdate).toMatchObject({
      where: expect.objectContaining({ entry: { is: { status: "ACTIVE" } } })
    });
    expect(auditSpy).toHaveBeenCalled();
    expect(outboxSpy).toHaveBeenCalled();
  });

  it("rejects a submitter reviewing their own knowledge version before writing review facts", async () => {
    const client = transaction({
      knowledgeEntryVersion: {
        findUnique: vi.fn(async () => ({
          id: "knowledge-version-1",
          entryId: "knowledge-entry-1",
          sourceProjectId: "source-project-1",
          status: "IN_REVIEW",
          submittedById: "author-1",
          entry: {
            id: "knowledge-entry-1",
            status: "ACTIVE",
            version: 5,
            currentPublishedVersionId: null
          }
        }))
      }
    });

    await expect(
      reviewKnowledgeEntryVersion(
        {
          entryId: "knowledge-entry-1",
          versionId: "knowledge-version-1",
          expectedEntryVersion: 5,
          decision: "PUBLISH",
          reason: "The submitter must not approve the same source.",
          ipConfirmed: true,
          sanitizationConfirmed: true,
          actorId: "author-1",
          idempotencyKey: "knowledge-review-self-1",
          sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: true }
        },
        client
      )
    ).rejects.toMatchObject({ code: "KNOWLEDGE_INDEPENDENT_REVIEW_REQUIRED", status: 403 });
    expect(client.knowledgeEntryReview.create).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("rejects publishing a legacy in-review version after its entry is revoked without writing success facts", async () => {
    const client = transaction({
      knowledgeEntryVersion: {
        findUnique: vi.fn(async () => ({
          id: "knowledge-version-review-1",
          entryId: "knowledge-entry-1",
          sourceProjectId: "source-project-1",
          status: "IN_REVIEW",
          submittedById: "author-1",
          entry: {
            id: "knowledge-entry-1",
            status: "REVOKED",
            version: 5,
            currentPublishedVersionId: null
          }
        })),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      knowledgeEntry: { updateMany: vi.fn(async () => ({ count: 1 })) },
      knowledgeEntrySource: { findMany: vi.fn(async () => [{ sourceChecksum: "e".repeat(64) }]) },
      knowledgeEntryReview: { create: vi.fn(async () => ({ id: "review-1" })) }
    });

    await expect(
      reviewKnowledgeEntryVersion(
        {
          entryId: "knowledge-entry-1",
          versionId: "knowledge-version-review-1",
          expectedEntryVersion: 5,
          decision: "PUBLISH",
          reason: "The aggregate was revoked before the legacy review completed.",
          ipConfirmed: true,
          sanitizationConfirmed: true,
          actorId: "reviewer-1",
          idempotencyKey: "knowledge-review-revoked-1",
          sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: true }
        },
        client
      )
    ).rejects.toMatchObject({ code: "KNOWLEDGE_ENTRY_REVOKED", status: 409 });
    expect(client.knowledgeEntryVersion.updateMany).not.toHaveBeenCalled();
    expect(client.knowledgeEntry.updateMany).not.toHaveBeenCalled();
    expect(client.knowledgeEntryReview.create).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("fails before knowledge writes when the transaction cannot read the database clock", async () => {
    const client = transaction({
      $queryRaw: vi.fn(async () => []),
      knowledgeEntryVersion: {
        findUnique: vi.fn(async () => ({
          id: "knowledge-version-1",
          entryId: "knowledge-entry-1",
          sourceProjectId: "source-project-1",
          status: "DRAFT",
          createdById: "author-1",
          entry: { id: "knowledge-entry-1", status: "ACTIVE", version: 4 }
        })),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      knowledgeEntry: { updateMany: vi.fn(async () => ({ count: 1 })) }
    });

    await expect(
      submitKnowledgeEntryVersion(
        {
          entryId: "knowledge-entry-1",
          versionId: "knowledge-version-1",
          expectedEntryVersion: 4,
          actorId: "author-1",
          idempotencyKey: "knowledge-submit-clock-missing-1",
          sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: true }
        },
        client
      )
    ).rejects.toMatchObject({ code: "KNOWLEDGE_DATABASE_CLOCK_UNAVAILABLE", status: 503 });
    expect(client.knowledgeEntryVersion.updateMany).not.toHaveBeenCalled();
    expect(client.knowledgeEntry.updateMany).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("requires explicit IP and sanitization confirmation before publishing", async () => {
    const client = transaction({
      knowledgeEntryVersion: {
        findUnique: vi.fn(async () => ({
          id: "knowledge-version-1",
          entryId: "knowledge-entry-1",
          sourceProjectId: "source-project-1",
          status: "IN_REVIEW",
          submittedById: "author-1",
          entry: {
            id: "knowledge-entry-1",
            status: "ACTIVE",
            version: 5,
            currentPublishedVersionId: null
          }
        }))
      }
    });

    await expect(
      reviewKnowledgeEntryVersion(
        {
          entryId: "knowledge-entry-1",
          versionId: "knowledge-version-1",
          expectedEntryVersion: 5,
          decision: "PUBLISH",
          reason: "Confirmation is mandatory before publication.",
          ipConfirmed: true,
          sanitizationConfirmed: false,
          actorId: "reviewer-1",
          idempotencyKey: "knowledge-review-sanitization-1",
          sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: true }
        },
        client
      )
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_IP_SANITIZATION_CONFIRMATION_REQUIRED",
      status: 409
    });
    expect(client.knowledgeEntryReview.create).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("fails closed when publishing cannot supersede the exact former published version", async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const client = transaction({
      knowledgeEntryVersion: {
        findUnique: vi.fn(async () => ({
          id: "knowledge-version-2",
          entryId: "knowledge-entry-1",
          sourceProjectId: "source-project-1",
          status: "IN_REVIEW",
          submittedById: "author-1",
          entry: {
            id: "knowledge-entry-1",
            status: "ACTIVE",
            version: 5,
            currentPublishedVersionId: "knowledge-version-published-1"
          }
        })),
        updateMany
      },
      knowledgeEntry: { updateMany: vi.fn(async () => ({ count: 1 })) },
      knowledgeEntrySource: {
        findMany: vi.fn(async () => [{ sourceChecksum: "e".repeat(64) }])
      },
      knowledgeEntryReview: { create: vi.fn(async () => ({ id: "review-1" })) }
    });

    await expect(
      reviewKnowledgeEntryVersion(
        {
          entryId: "knowledge-entry-1",
          versionId: "knowledge-version-2",
          expectedEntryVersion: 5,
          decision: "PUBLISH",
          reason: "Internal reusable and sanitized.",
          ipConfirmed: true,
          sanitizationConfirmed: true,
          actorId: "reviewer-1",
          idempotencyKey: "knowledge-review-supersede-conflict-1",
          sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: true }
        },
        client
      )
    ).rejects.toMatchObject({ code: "KNOWLEDGE_ENTRY_VERSION_CONFLICT", status: 409 });
    expect(client.knowledgeEntry.updateMany).not.toHaveBeenCalled();
    expect(client.knowledgeEntryReview.create).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("revokes a published version without deleting its immutable source or review history", async () => {
    const client = transaction({
      knowledgeEntryVersion: {
        findUnique: vi.fn(async () => ({
          id: "knowledge-version-1",
          entryId: "knowledge-entry-1",
          sourceProjectId: "source-project-1",
          status: "PUBLISHED",
          entry: {
            id: "knowledge-entry-1",
            status: "ACTIVE",
            version: 6,
            currentPublishedVersionId: "knowledge-version-1"
          }
        })),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      knowledgeEntry: { updateMany: vi.fn(async () => ({ count: 1 })) }
    });

    const result = await revokeKnowledgeEntryVersion(
      {
        entryId: "knowledge-entry-1",
        versionId: "knowledge-version-1",
        expectedEntryVersion: 6,
        reason: "Source intellectual-property permission was withdrawn.",
        actorId: "reviewer-1",
        idempotencyKey: "knowledge-revoke-1",
        sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: true }
      },
      client
    );

    expect(result).toMatchObject({ status: "REVOKED" });
    expect(client.knowledgeEntryVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REVOKED" }) })
    );
    expect(client.knowledgeEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REVOKED", currentPublishedVersionId: null })
      })
    );
    expect(auditSpy).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        action: "KNOWLEDGE_ENTRY_REVIEWED",
        after: expect.objectContaining({ value: expect.objectContaining({ decision: "REVOKE" }) })
      })
    );
    expect(client.knowledgeEntrySource).not.toHaveProperty("delete");
    expect(client.knowledgeEntryReview).not.toHaveProperty("delete");
    expect(auditSpy).toHaveBeenCalled();
    expect(outboxSpy).toHaveBeenCalled();
  });
});
