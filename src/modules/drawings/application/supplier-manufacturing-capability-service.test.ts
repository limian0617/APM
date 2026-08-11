import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditContext } from "@/modules/audit/contracts/audit";

const { auditSpy, outboxSpy } = vi.hoisted(() => ({
  auditSpy: vi.fn(async () => ({ id: "audit-1" })),
  outboxSpy: vi.fn(async () => ({ id: "outbox-1" }))
}));

vi.mock("@/modules/audit/infrastructure/write-audit", () => ({ writeAudit: auditSpy }));
vi.mock("@/modules/governance/infrastructure/outbox", () => ({
  appendOutboxEvent: outboxSpy
}));

import {
  listSupplierMatches,
  resolveSupplierMatch,
  updateSupplierCapability
} from "./supplier-manufacturing-capability-service";

const auditContext: AuditContext = {
  actorId: null,
  requestId: "request-1",
  traceId: "trace-1",
  source: "API",
  sourceIp: null,
  userAgent: null,
  reason: null,
  projectId: "project-a",
  departmentId: null,
  operationId: "operation-1"
};

function category(overrides: Record<string, unknown> = {}) {
  return {
    id: "category-1",
    code: "MACHINING",
    name: "Machining",
    sortOrder: 1,
    isActive: true,
    version: 1,
    ...overrides
  };
}

function tag(overrides: Record<string, unknown> = {}) {
  return {
    id: "tag-1",
    code: "MILLING",
    name: "Milling",
    sortOrder: 1,
    isActive: true,
    version: 1,
    ...overrides
  };
}

function supplier(overrides: Record<string, unknown> = {}) {
  return {
    id: "supplier-1",
    projectId: "project-a",
    code: "SUP-1",
    name: "Supplier 1",
    status: "ACTIVE",
    version: 1,
    ...overrides
  };
}

function capability(overrides: Record<string, unknown> = {}) {
  return {
    id: "capability-1",
    projectId: "project-a",
    supplierReferenceId: "supplier-1",
    manufacturingCategoryId: "category-1",
    isActive: true,
    version: 1,
    manufacturingCategory: category(),
    supplierReference: supplier(),
    processCapabilities: [
      {
        id: "process-capability-1",
        projectId: "project-a",
        supplierCapabilityId: "capability-1",
        processTagId: "tag-1",
        isActive: true,
        version: 1,
        processTag: tag()
      }
    ],
    ...overrides
  };
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn(async () => []),
    supplierReference: {
      findFirst: vi.fn(async () => supplier()),
      findUnique: vi.fn(async () => supplier())
    },
    supplierReferenceManufacturingCapability: {
      findFirst: vi.fn(async () => capability()),
      findUnique: vi.fn(async () => capability()),
      findUniqueOrThrow: vi.fn(async () => capability({ version: 2 })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        capability({ ...data, id: "capability-created", version: 1 })
      ),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    supplierReferenceProcessCapability: {
      findMany: vi.fn(async () => capability().processCapabilities),
      updateMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 }))
    },
    manufacturingCategory: {
      findUnique: vi.fn(async () => category())
    },
    processTag: {
      findMany: vi.fn(async () => [tag()])
    },
    ...overrides
  } as any;
}

beforeEach(() => {
  auditSpy.mockClear();
  outboxSpy.mockClear();
});

describe("APM-053 supplier manufacturing capability", () => {
  it.each(["MACHINING", "SHEET_METAL"])(
    "finds same-project default matches for %s",
    async (categoryCode) => {
      const tx = transaction({
        manufacturingCategory: {
          findUnique: vi.fn(async () => category({ code: categoryCode }))
        },
        supplierReferenceManufacturingCapability: {
          findMany: vi.fn(async () => [
            capability({ manufacturingCategory: category({ code: categoryCode }) })
          ])
        }
      });

      await expect(
        listSupplierMatches({ projectId: "project-a", categoryCode, processTagCodes: [] }, tx)
      ).resolves.toMatchObject({
        status: "MATCHED",
        matches: [{ supplierReferenceId: "supplier-1" }]
      });
    }
  );

  it("returns an explicit no-match result when process coverage is incomplete", async () => {
    const tx = transaction({
      supplierReferenceManufacturingCapability: {
        findMany: vi.fn(async () => [capability({ processCapabilities: [] })])
      }
    });

    await expect(
      listSupplierMatches(
        { projectId: "project-a", categoryCode: "MACHINING", processTagCodes: ["MILLING"] },
        tx
      )
    ).resolves.toMatchObject({ status: "NO_MATCH", matches: [] });
  });

  it("resolves a selected same-project supplier without exposing legacy JSON capabilities", async () => {
    const tx = transaction({
      supplierReferenceManufacturingCapability: {
        findMany: vi.fn(async () => [capability()])
      }
    });

    await expect(
      resolveSupplierMatch(tx, {
        projectId: "project-a",
        supplierReferenceId: "supplier-1",
        classification: { categoryCode: "MACHINING", processTagCodes: ["MILLING"] }
      })
    ).resolves.toMatchObject({ status: "MATCHED", isDefault: true, capabilityId: "capability-1" });
  });

  it("does not disclose or mutate a supplier reference from another project", async () => {
    const tx = transaction({
      supplierReference: { findFirst: vi.fn(async () => null) }
    });

    await expect(
      updateSupplierCapability(
        {
          projectId: "project-a",
          supplierReferenceId: "supplier-b",
          categoryCode: "MACHINING",
          processTagCodes: [],
          version: 1,
          reason: "update capability",
          actorId: "actor-1",
          auditContext
        },
        tx
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(tx.supplierReferenceManufacturingCapability.updateMany).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("rejects stale capability updates without success side effects", async () => {
    const tx = transaction({
      supplierReferenceManufacturingCapability: {
        findFirst: vi.fn(async () => capability({ version: 2 })),
        updateMany: vi.fn(async () => ({ count: 0 }))
      }
    });

    await expect(
      updateSupplierCapability(
        {
          projectId: "project-a",
          supplierReferenceId: "supplier-1",
          categoryCode: "MACHINING",
          processTagCodes: [],
          version: 1,
          reason: "stale update",
          actorId: "actor-1",
          auditContext
        },
        tx
      )
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("writes capability changes, audit, and Outbox through the caller transaction", async () => {
    const tx = transaction();

    const result = await updateSupplierCapability(
      {
        projectId: "project-a",
        supplierReferenceId: "supplier-1",
        categoryCode: "MACHINING",
        processTagCodes: ["MILLING"],
        version: 1,
        reason: "refresh supplier capability",
        actorId: "actor-1",
        auditContext
      },
      tx
    );

    expect(result).toMatchObject({
      resourceVersion: 2,
      auditId: "audit-1",
      outboxEventId: "outbox-1"
    });
    expect(tx.supplierReferenceManufacturingCapability.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: "project-a", version: 1 })
      })
    );
    expect(auditSpy).toHaveBeenCalledWith(tx, expect.any(Object));
    expect(outboxSpy).toHaveBeenCalledWith(tx, expect.any(Object));
  });

  it("rejects inactive category or tag assignments unless already retained", async () => {
    const tx = transaction({
      manufacturingCategory: {
        findUnique: vi.fn(async () => category({ id: "category-disabled", isActive: false }))
      },
      processTag: {
        findMany: vi.fn(async () => [tag({ id: "tag-disabled", isActive: false })])
      }
    });

    await expect(
      updateSupplierCapability(
        {
          projectId: "project-a",
          supplierReferenceId: "supplier-1",
          categoryCode: "MACHINING",
          processTagCodes: ["MILLING"],
          version: 1,
          reason: "use disabled values",
          actorId: "actor-1",
          auditContext
        },
        tx
      )
    ).rejects.toMatchObject({ code: "INACTIVE_CLASSIFICATION", status: 409 });
  });

  it("retains removed process capability history by disabling the link", async () => {
    const tx = transaction();
    await updateSupplierCapability(
      {
        projectId: "project-a",
        supplierReferenceId: "supplier-1",
        categoryCode: "MACHINING",
        processTagCodes: [],
        version: 1,
        reason: "retire milling capability",
        actorId: "actor-1",
        auditContext
      },
      tx
    );

    expect(tx.supplierReferenceProcessCapability.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ processTagId: { notIn: [] } }),
        data: expect.objectContaining({ isActive: false })
      })
    );
    expect(tx.supplierReferenceProcessCapability.deleteMany).toBeUndefined();
  });
});
