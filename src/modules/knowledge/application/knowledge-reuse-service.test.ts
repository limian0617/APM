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

const transactionNow = new Date("2026-08-14T12:34:56.000Z");

function adoptableSelector(overrides: Record<string, unknown> = {}) {
  return {
    entryId: "knowledge-entry-1",
    entryStatus: "ACTIVE",
    currentPublishedVersionId: "knowledge-version-1",
    knowledgeVersionId: "knowledge-version-1",
    knowledgeVersionStatus: "PUBLISHED",
    internalReusable: true,
    ...overrides
  };
}

function selectorAwareClock(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (strings: TemplateStringsArray) =>
    strings.join("").includes("knowledge_entries")
      ? [adoptableSelector(overrides)]
      : [{ now: transactionNow }]
  );
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: selectorAwareClock(),
    project: {
      findUnique: vi.fn(async () => ({ id: "target-project-1", status: "IN_PROGRESS" }))
    },
    projectMember: {
      findFirst: vi.fn(async () => ({ id: "target-membership-1", projectId: "target-project-1" }))
    },
    deliveryUnit: { findFirst: vi.fn(async () => null) },
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
  it("resolves and locks a public entryCode plus version selector before persisting internal IDs", async () => {
    const client = transaction();

    await expect(
      confirmKnowledgeReuse(
        {
          targetProjectId: "target-project-1",
          targetDeliveryUnitId: null,
          entryCode: "KNW-001",
          version: 1,
          scenario: "Adopt the commissioning tuning checklist.",
          evidenceSummary: "Project manager confirmed its use during commissioning review.",
          actorId: "target-manager-1",
          idempotencyKey: "knowledge-reuse-public-selector-1",
          targetProjectAccess: true
        } as any,
        client
      )
    ).resolves.toMatchObject({ id: "reuse-1" });

    expect(client.knowledgeReuseRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          knowledgeEntryId: "knowledge-entry-1",
          knowledgeVersionId: "knowledge-version-1"
        })
      })
    );
    expect(client.$queryRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("knowledge_entries")]),
      "KNW-001",
      1
    );
  });

  it("creates one target-project reuse fact only after an authorized person manually confirms a published reusable version", async () => {
    const client = transaction();

    const result = await confirmKnowledgeReuse(
      {
        targetProjectId: "target-project-1",
        entryCode: "KNW-001",
        version: 1,
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
          confirmedById: "target-membership-1",
          confirmedAt: transactionNow
        })
      })
    );
    expect(auditSpy).toHaveBeenCalled();
    expect(outboxSpy).toHaveBeenCalled();
    expect(client.$queryRaw).toHaveBeenCalled();
  });

  it("rejects a published version whose knowledge entry is revoked or no longer points to it", async () => {
    for (const entry of [
      { id: "knowledge-entry-1", status: "REVOKED", currentPublishedVersionId: null },
      {
        id: "knowledge-entry-1",
        status: "ACTIVE",
        currentPublishedVersionId: "knowledge-version-current-2"
      }
    ]) {
      const client = transaction({
        $queryRaw: selectorAwareClock({
          entryStatus: entry.status,
          currentPublishedVersionId: entry.currentPublishedVersionId
        })
      });

      await expect(
        confirmKnowledgeReuse(
          {
            targetProjectId: "target-project-1",
            entryCode: "KNW-001",
            version: 1,
            targetDeliveryUnitId: null,
            scenario: "Adopt the commissioning tuning checklist.",
            evidenceSummary: "Project manager confirmed the actual use.",
            actorId: "target-manager-1",
            idempotencyKey: `knowledge-reuse-not-adoptable-${entry.status}`,
            targetProjectAccess: true
          },
          client
        )
      ).rejects.toMatchObject({ code: "KNOWLEDGE_REUSE_VERSION_NOT_ADOPTABLE", status: 409 });
      expect(client.knowledgeReuseRecord.create).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalled();
      expect(outboxSpy).not.toHaveBeenCalled();
    }
  });

  it("fails before creating a reuse fact when the transaction clock is unavailable", async () => {
    const client = transaction({
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
        strings.join("").includes("knowledge_entries") ? [adoptableSelector()] : []
      )
    });

    await expect(
      confirmKnowledgeReuse(
        {
          targetProjectId: "target-project-1",
          entryCode: "KNW-001",
          version: 1,
          targetDeliveryUnitId: null,
          scenario: "Adopt the commissioning tuning checklist.",
          evidenceSummary: "Project manager confirmed the actual use.",
          actorId: "target-manager-1",
          idempotencyKey: "knowledge-reuse-clock-missing-1",
          targetProjectAccess: true
        },
        client
      )
    ).rejects.toMatchObject({ code: "KNOWLEDGE_DATABASE_CLOCK_UNAVAILABLE", status: 503 });
    expect(client.knowledgeReuseRecord.create).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
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
        entryCode: "KNW-001",
        version: 1,
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
        entryCode: "KNW-001",
        version: 1,
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
