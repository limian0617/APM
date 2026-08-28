import { describe, expect, it, vi } from "vitest";

import { payloadHash } from "@/modules/governance/domain/idempotency";

import {
  createRetrospectiveVersion,
  reviewRetrospectiveVersion,
  submitRetrospectiveVersion
} from "./project-retrospective-service";

const content = {
  deliverySummary: { summary: "交付范围与实际结果" },
  successfulPractices: { practices: ["先行验证接口"] },
  shortcomings: { items: ["试运行窗口偏短"] },
  improvements: { actions: ["增加复测窗口"] },
  knowledgeDisposition: { disposition: "PUBLISH_CANDIDATE" },
  ipDeclaration: { customerOwned: true, sanitized: true, excludedFields: ["客户姓名"] }
} as const;

function clientFixture() {
  const archive = {
    id: "archive-a",
    projectId: "project-1",
    status: "READY",
    archiveSourceFormulaVersion: "V2",
    retrospectiveInputApplicability: "APPLICABLE",
    retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
    retrospectiveInputSnapshotJson: { formulaVersion: "RETROSPECTIVE.INPUT@1" },
    retrospectiveInputWatermark: "a".repeat(64),
    manifestChecksum: "b".repeat(64),
    sourceWatermark: "c".repeat(64),
    integrityChecks: [{ status: "PASSED" }]
  };
  const project = {
    id: "project-1",
    status: "IN_PROGRESS",
    code: "P-001",
    name: "项目",
    projectType: "CUSTOMER_DELIVERY",
    mainControlStageCode: "S2",
    retrospective: null
  };
  return {
    project: { findUnique: vi.fn().mockResolvedValue(project) },
    projectArchiveVersion: { findFirst: vi.fn().mockResolvedValue(archive) },
    projectMember: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({ id: "active-membership", userId: "submitter-1" })
    },
    deliveryUnit: { findMany: vi.fn().mockResolvedValue([]) },
    issueHistory: { findMany: vi.fn().mockResolvedValue([]) },
    projectRetrospective: {
      upsert: vi
        .fn()
        .mockResolvedValue({ id: "retrospective-1", projectId: "project-1", version: 1 }),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    projectRetrospectiveVersion: {
      create: vi
        .fn()
        .mockResolvedValue({ id: "retro-version-1", projectId: "project-1", versionNo: 1 }),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({
        id: "retro-version-1",
        projectId: "project-1",
        retrospectiveId: "retrospective-1",
        status: "DRAFT",
        submittedById: "submitter-1",
        retrospective: { version: 1, currentVersionId: "retro-version-1" }
      }),
      update: vi.fn().mockResolvedValue({ id: "retro-version-1", status: "IN_REVIEW" })
    },
    projectRetrospectiveContribution: { createMany: vi.fn() },
    projectRetrospectiveParticipant: { createMany: vi.fn() },
    projectRetrospectiveIssueSource: { createMany: vi.fn() },
    projectRetrospectiveReview: { create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    outboxEvent: {
      upsert: vi.fn().mockImplementation(async (input: any) => ({
        id: "outbox-1",
        payloadHash: input.create.payloadHash,
        aggregateType: input.create.aggregateType,
        aggregateId: input.create.aggregateId
      }))
    },
    $transaction: vi.fn(async (callback: (client: any) => unknown) => callback(undefined))
  };
}

describe("project retrospective service", () => {
  it("rejects a legacy or cross-project Archive A before creating a version", async () => {
    const client = clientFixture();
    client.projectArchiveVersion.findFirst.mockResolvedValueOnce({
      ...clientFixture().projectArchiveVersion.findFirst.getMockImplementation?.(),
      id: "archive-a",
      projectId: "other-project",
      status: "READY",
      archiveSourceFormulaVersion: "V1",
      retrospectiveInputApplicability: "NOT_APPLICABLE"
    });

    await expect(
      createRetrospectiveVersion(
        {
          projectId: "project-1",
          retrospectiveInputArchiveVersionId: "archive-a",
          expectedAggregateVersion: null,
          content,
          contributionInputs: [],
          participantMembershipIds: [],
          issueHistoryIds: [],
          actorId: "submitter-1",
          idempotencyKey: "retro-create-1",
          auditContext: { actorId: "submitter-1", projectId: "project-1" } as any
        },
        client as any
      )
    ).rejects.toMatchObject({ code: "RETROSPECTIVE_INPUT_ARCHIVE_NOT_APPLICABLE" });
    expect(client.projectRetrospectiveVersion.create).not.toHaveBeenCalled();
  });

  it("creates a new immutable version with frozen Archive A and content checksum", async () => {
    const client = clientFixture();
    const result = await createRetrospectiveVersion(
      {
        projectId: "project-1",
        retrospectiveInputArchiveVersionId: "archive-a",
        expectedAggregateVersion: null,
        content,
        contributionInputs: [],
        participantMembershipIds: [],
        issueHistoryIds: [],
        actorId: "submitter-1",
        idempotencyKey: "retro-create-1",
        auditContext: { actorId: "submitter-1", projectId: "project-1" } as any
      },
      client as any
    );

    expect(client.projectRetrospectiveVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: "project-1",
          retrospectiveInputArchiveVersionId: "archive-a",
          retrospectiveInputManifestChecksum: "b".repeat(64),
          retrospectiveInputSourceWatermark: "c".repeat(64),
          retrospectiveInputWatermark: "a".repeat(64),
          contentChecksum: expect.stringMatching(/^[0-9a-f]{64}$/u),
          status: "DRAFT"
        })
      })
    );
    expect(result.auditId).toBe("audit-1");
    expect(result.outboxEventId).toBe("outbox-1");
  });

  it("supersedes a prior draft without changing an approved history row", async () => {
    const client = clientFixture();
    client.projectRetrospectiveVersion.findFirst
      .mockResolvedValueOnce({ versionNo: 1 })
      .mockResolvedValueOnce({ id: "draft-version-1", status: "DRAFT" });
    await createRetrospectiveVersion(
      {
        projectId: "project-1",
        retrospectiveInputArchiveVersionId: "archive-a",
        expectedAggregateVersion: 1,
        content,
        contributionInputs: [],
        participantMembershipIds: [],
        issueHistoryIds: [],
        actorId: "submitter-1",
        idempotencyKey: "retro-create-supersede-draft",
        auditContext: { actorId: "submitter-1", projectId: "project-1" } as any
      },
      client as any
    );
    expect(client.projectRetrospectiveVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "draft-version-1", status: "DRAFT" }),
        data: { status: "SUPERSEDED" }
      })
    );
  });

  it("ignores a client project snapshot and freezes the server project fact", async () => {
    const client = clientFixture();
    await createRetrospectiveVersion(
      {
        projectId: "project-1",
        retrospectiveInputArchiveVersionId: "archive-a",
        expectedAggregateVersion: null,
        content: { ...content, projectSnapshot: { id: "other-project", code: "FORGED" } },
        contributionInputs: [],
        participantMembershipIds: [],
        issueHistoryIds: [],
        actorId: "submitter-1",
        idempotencyKey: "retro-create-server-snapshot",
        auditContext: { actorId: "submitter-1", projectId: "project-1" } as any
      },
      client as any
    );
    expect(client.projectRetrospectiveVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectSnapshotJson: expect.objectContaining({ id: "project-1", code: "P-001" })
        })
      })
    );
  });

  it("rejects a participant membership that is not in the project", async () => {
    const client = clientFixture();
    await expect(
      createRetrospectiveVersion(
        {
          projectId: "project-1",
          retrospectiveInputArchiveVersionId: "archive-a",
          expectedAggregateVersion: null,
          content,
          contributionInputs: [],
          participantMembershipIds: ["membership-from-other-project"],
          issueHistoryIds: [],
          actorId: "submitter-1",
          idempotencyKey: "retro-create-cross-project-membership",
          auditContext: { actorId: "submitter-1", projectId: "project-1" } as any
        },
        client as any
      )
    ).rejects.toMatchObject({ code: "RETROSPECTIVE_SOURCE_NOT_IN_PROJECT" });
  });

  it("rejects a delivery-unit contribution whose sources are outside the project", async () => {
    const client = clientFixture();
    await expect(
      createRetrospectiveVersion(
        {
          projectId: "project-1",
          retrospectiveInputArchiveVersionId: "archive-a",
          expectedAggregateVersion: null,
          content,
          contributionInputs: [
            {
              scopeType: "DELIVERY_UNIT",
              deliveryUnitId: "delivery-unit-from-other-project",
              discipline: "机械",
              contributorMembershipId: "member-from-other-project",
              factText: "现场复测事实",
              impactText: "影响交付节奏",
              reusable: true,
              required: true
            }
          ],
          participantMembershipIds: [],
          issueHistoryIds: [],
          actorId: "submitter-1",
          idempotencyKey: "retro-create-cross-project-contribution",
          auditContext: { actorId: "submitter-1", projectId: "project-1" } as any
        },
        client as any
      )
    ).rejects.toMatchObject({ code: "RETROSPECTIVE_SOURCE_NOT_IN_PROJECT" });
    expect(client.projectRetrospectiveVersion.create).not.toHaveBeenCalled();
  });

  it("requires expected aggregate version and independent reviewer for submit/review", async () => {
    const client = clientFixture();
    await expect(
      submitRetrospectiveVersion(
        {
          projectId: "project-1",
          versionId: "retro-version-1",
          expectedAggregateVersion: 1,
          actorId: "submitter-1",
          idempotencyKey: "retro-submit-1",
          auditContext: { actorId: "submitter-1", projectId: "project-1" } as any
        },
        client as any
      )
    ).resolves.toMatchObject({ status: "IN_REVIEW" });

    await expect(
      reviewRetrospectiveVersion(
        {
          projectId: "project-1",
          versionId: "retro-version-1",
          decision: "APPROVED",
          reason: "批准",
          expectedAggregateVersion: 1,
          actorId: "submitter-1",
          idempotencyKey: "retro-review-1",
          auditContext: { actorId: "submitter-1", projectId: "project-1" } as any
        },
        client as any
      )
    ).rejects.toMatchObject({ code: "RETROSPECTIVE_INDEPENDENT_REVIEW_REQUIRED" });
  });

  it("advances the aggregate version for submit and review compare-and-swap", async () => {
    const client = clientFixture();
    client.projectRetrospective.updateMany.mockResolvedValue({ count: 1 });
    await submitRetrospectiveVersion(
      {
        projectId: "project-1",
        versionId: "retro-version-1",
        expectedAggregateVersion: 1,
        actorId: "submitter-1",
        idempotencyKey: "retro-submit-cas",
        auditContext: { actorId: "submitter-1", projectId: "project-1" } as any
      },
      client as any
    );
    expect(client.projectRetrospective.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "retrospective-1",
          projectId: "project-1",
          version: 1,
          currentVersionId: "retro-version-1"
        },
        data: expect.objectContaining({ version: { increment: 1 } })
      })
    );
  });

  it("rejects a command actor without an active project membership", async () => {
    const client = clientFixture();
    client.projectMember.findFirst.mockResolvedValue(null);
    await expect(
      createRetrospectiveVersion(
        {
          projectId: "project-1",
          retrospectiveInputArchiveVersionId: "archive-a",
          expectedAggregateVersion: null,
          content,
          contributionInputs: [],
          participantMembershipIds: [],
          issueHistoryIds: [],
          actorId: "former-member",
          idempotencyKey: "retro-create-former-member",
          auditContext: { actorId: "former-member", projectId: "project-1" } as any
        },
        client as any
      )
    ).rejects.toMatchObject({ code: "RETROSPECTIVE_ACTIVE_MEMBERSHIP_REQUIRED" });
  });
});
