import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditSpy, outboxSpy } = vi.hoisted(() => ({
  auditSpy: vi.fn(async () => ({ id: "audit-reuse-1" })),
  outboxSpy: vi.fn(async () => ({ id: "outbox-reuse-1" }))
}));

vi.mock("@/modules/audit/infrastructure/write-audit", () => ({ writeAudit: auditSpy }));
vi.mock("@/modules/governance/infrastructure/outbox", () => ({
  appendOutboxEvent: outboxSpy
}));

import { confirmKnowledgeReuse, correctKnowledgeReuse } from "./knowledge-reuse-service";

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    project: {
      findUnique: vi.fn(async () => ({ id: "target-project-1", status: "IN_PROGRESS" }))
    },
    projectMember: {
      findFirst: vi.fn(async () => ({ id: "target-membership-1", projectId: "target-project-1" }))
    },
    deliveryUnit: { findFirst: vi.fn(async () => null) },
    knowledgeEntryVersion: {
      findUnique: vi.fn(async () => ({
        id: "knowledge-version-1",
        entryId: "knowledge-entry-1",
        status: "PUBLISHED",
        internalReusable: true
      }))
    },
    knowledgeReuseRecord: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "reuse-1",
        version: 1,
        ...data
      }))
    },
    knowledgeReuseCorrection: { create: vi.fn() },
    ...overrides
  } as any;
}

beforeEach(() => {
  auditSpy.mockClear();
  outboxSpy.mockClear();
});

describe("knowledge reuse service", () => {
  it("creates one target-project reuse fact only after an authorized person manually confirms a published reusable version", async () => {
    const client = transaction();

    const result = await confirmKnowledgeReuse(
      {
        targetProjectId: "target-project-1",
        knowledgeEntryId: "knowledge-entry-1",
        knowledgeVersionId: "knowledge-version-1",
        targetDeliveryUnitId: null,
        scenario: "Adopt the commissioning tuning checklist.",
        evidenceSummary: "Project manager confirmed its use during commissioning review.",
        actorId: "target-manager-1",
        idempotencyKey: "knowledge-reuse-1",
        targetProjectAccess: true
      },
      client
    );

    expect(result).toMatchObject({ id: "reuse-1", idempotent: false });
    expect(client.knowledgeReuseRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetProjectId: "target-project-1",
          knowledgeVersionId: "knowledge-version-1",
          confirmedById: "target-membership-1"
        })
      })
    );
    expect(auditSpy).toHaveBeenCalled();
    expect(outboxSpy).toHaveBeenCalled();
  });

  it("replays the same manual confirmation with a canonical idempotency key without a second fact", async () => {
    const client = transaction({
      knowledgeReuseRecord: {
        findUnique: vi.fn(async () => ({
          id: "reuse-1",
          targetProjectId: "target-project-1",
          knowledgeEntryId: "knowledge-entry-1",
          knowledgeVersionId: "knowledge-version-1",
          idempotencyKey: "knowledge-reuse-1"
        })),
        create: vi.fn()
      }
    });

    const result = await confirmKnowledgeReuse(
      {
        targetProjectId: "target-project-1",
        knowledgeEntryId: "knowledge-entry-1",
        knowledgeVersionId: "knowledge-version-1",
        targetDeliveryUnitId: null,
        scenario: "Adopt the commissioning tuning checklist.",
        evidenceSummary: "Project manager confirmed its use during commissioning review.",
        actorId: "target-manager-1",
        idempotencyKey: " knowledge-reuse-1 ",
        targetProjectAccess: true
      },
      client
    );

    expect(result).toMatchObject({ id: "reuse-1", idempotent: true });
    expect(client.knowledgeReuseRecord.create).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("persists the validated target delivery-unit identifier instead of the raw request text", async () => {
    const client = transaction({
      deliveryUnit: { findFirst: vi.fn(async () => ({ id: "target-unit-1" })) }
    });

    await confirmKnowledgeReuse(
      {
        targetProjectId: "target-project-1",
        knowledgeEntryId: "knowledge-entry-1",
        knowledgeVersionId: "knowledge-version-1",
        targetDeliveryUnitId: " target-unit-1 ",
        scenario: "Adopt the commissioning tuning checklist.",
        evidenceSummary: "Project manager confirmed its use during commissioning review.",
        actorId: "target-manager-1",
        idempotencyKey: "knowledge-reuse-delivery-unit-1",
        targetProjectAccess: true
      },
      client
    );

    expect(client.knowledgeReuseRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ targetDeliveryUnitId: "target-unit-1" })
      })
    );
  });

  it("appends a correction without overwriting or deleting the original reuse confirmation", async () => {
    const client = transaction({
      knowledgeReuseRecord: {
        findUnique: vi.fn(async () => ({
          id: "reuse-1",
          targetProjectId: "target-project-1",
          version: 1,
          knowledgeEntryId: "knowledge-entry-1",
          knowledgeVersionId: "knowledge-version-1"
        }))
      },
      knowledgeReuseCorrection: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "correction-1",
          ...data
        }))
      }
    });

    const result = await correctKnowledgeReuse(
      {
        targetProjectId: "target-project-1",
        reuseRecordId: "reuse-1",
        expectedReuseVersion: 1,
        correctionType: "TEXT_CORRECTION",
        reason: "Clarify the adoption scenario.",
        correctionText: "Applied only during no-load commissioning.",
        actorId: "target-manager-1",
        idempotencyKey: "knowledge-correction-1",
        targetProjectAccess: true
      },
      client
    );

    expect(result).toMatchObject({ id: "correction-1", reuseRecordId: "reuse-1" });
    expect(client.knowledgeReuseCorrection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetProjectId: "target-project-1",
          reuseRecordId: "reuse-1",
          correctionType: "TEXT_CORRECTION"
        })
      })
    );
    expect(client.knowledgeReuseRecord).not.toHaveProperty("update");
    expect(client.knowledgeReuseRecord).not.toHaveProperty("delete");
    expect(auditSpy).toHaveBeenCalled();
    expect(outboxSpy).toHaveBeenCalled();
  });
});
