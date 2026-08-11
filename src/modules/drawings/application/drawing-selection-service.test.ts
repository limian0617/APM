import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditContext } from "@/modules/audit/contracts/audit";

const { auditSpy, outboxSpy } = vi.hoisted(() => ({
  auditSpy: vi.fn(async () => ({ id: "audit-selection-1" })),
  outboxSpy: vi.fn(async () => ({ id: "outbox-selection-1" }))
}));

vi.mock("@/modules/audit/infrastructure/write-audit", () => ({ writeAudit: auditSpy }));
vi.mock("@/modules/governance/infrastructure/outbox", () => ({
  appendOutboxEvent: outboxSpy
}));

import {
  addDrawingSelectionItem,
  createDrawingSelectionSet,
  getDrawingSelectionSet,
  listDrawingSelectionSets,
  lockDrawingSelectionSet,
  updateDrawingSelectionItem
} from "./drawing-selection-service";

const auditContext: AuditContext = {
  actorId: null,
  requestId: "request-selection-1",
  traceId: "trace-selection-1",
  source: "API",
  sourceIp: null,
  userAgent: null,
  reason: null,
  projectId: "project-a",
  departmentId: null,
  operationId: "operation-selection-1"
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

function drawing(overrides: Record<string, unknown> = {}) {
  return {
    id: "drawing-1",
    projectId: "project-a",
    documentId: "document-1",
    drawingNumber: "DWG-001",
    drawingType: "PART",
    manufacturingCategoryId: "category-1",
    version: 3,
    manufacturingCategory: category(),
    processTags: [
      {
        id: "drawing-tag-1",
        projectId: "project-a",
        drawingId: "drawing-1",
        processTagId: "tag-1",
        processTag: tag()
      }
    ],
    ...overrides
  };
}

function documentVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: "version-1",
    projectId: "project-a",
    documentId: "document-1",
    version: 7,
    status: "PUBLISHED",
    ...overrides
  };
}

function selectionSet(overrides: Record<string, unknown> = {}) {
  return {
    id: "selection-set-1",
    projectId: "project-a",
    code: "SET-001",
    title: "Inquiry set",
    status: "DRAFT",
    version: 1,
    createdById: "actor-1",
    items: [],
    ...overrides
  };
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "selection-item-1",
    projectId: "project-a",
    selectionSetId: "selection-set-1",
    drawingId: "drawing-1",
    documentVersionId: "version-1",
    manufacturingCategoryCodeSnapshot: "MACHINING",
    processTagCodesSnapshotJson: ["MILLING"],
    drawingNumberSnapshot: "DWG-001",
    drawingVersionSnapshot: 7,
    version: 1,
    quantity: 2,
    spareQuantity: 1,
    requiredOn: new Date("2026-08-30"),
    supplierReferenceId: "supplier-1",
    purpose: "INQUIRY",
    supplierMatchState: "DEFAULT_MATCH",
    supplierExceptionReason: null,
    supplierCapabilitySnapshotJson: { capabilityId: "capability-1" },
    createdById: "actor-1",
    ...overrides
  };
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn(async () => []),
    drawingSelectionSet: {
      findUnique: vi.fn(async () => selectionSet()),
      findUniqueOrThrow: vi.fn(async () => selectionSet({ version: 2 })),
      findMany: vi.fn(async () => [selectionSet()]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        selectionSet({ ...data, id: "selection-set-created" })
      ),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    drawingSelectionItem: {
      findUnique: vi.fn(async () => item()),
      findMany: vi.fn(async () => [item()]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        item({ ...data, id: "selection-item-created" })
      ),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    mechanicalDrawing: {
      findFirst: vi.fn(async () => drawing())
    },
    controlledDocumentVersion: {
      findFirst: vi.fn(async () => documentVersion())
    },
    mechanicalDrawingVersionFile: {
      findMany: vi.fn(async () => [
        {
          role: "CAD_SOURCE",
          file: {
            id: "file-1",
            projectId: "project-a",
            status: "AVAILABLE",
            storageArea: "CONTROLLED",
            scannedAt: new Date("2026-08-11"),
            sha256: "a".repeat(64),
            verifiedMimeType: "application/octet-stream",
            verifiedSize: 1024n
          }
        }
      ])
    },
    supplierReference: {
      findFirst: vi.fn(async () => supplier())
    },
    supplierReferenceManufacturingCapability: {
      findMany: vi.fn(async () => [
        {
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
          ]
        }
      ])
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

const baseInput = {
  projectId: "project-a",
  selectionSetId: "selection-set-1",
  drawingId: "drawing-1",
  documentVersionId: "version-1",
  quantity: 2,
  spareQuantity: 1,
  requiredOn: new Date("2026-08-30"),
  supplierReferenceId: "supplier-1",
  purpose: "INQUIRY" as const,
  exceptionReason: null,
  version: 1,
  actorId: "actor-1",
  reason: "prepare internal inquiry",
  auditContext
};

beforeEach(() => {
  auditSpy.mockClear();
  outboxSpy.mockClear();
});

describe("APM-053 drawing selection commands", () => {
  it("lists only the current project's internal selection sets", async () => {
    const tx = transaction();

    await expect(listDrawingSelectionSets({ projectId: "project-a" }, tx)).resolves.toEqual([
      selectionSet()
    ]);
    expect(tx.drawingSelectionSet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "project-a" },
        include: { items: true }
      })
    );
  });

  it("creates a draft selection set through the caller transaction", async () => {
    const tx = transaction();
    const result = await createDrawingSelectionSet(
      {
        projectId: "project-a",
        code: " set-001 ",
        title: "Inquiry set",
        actorId: "actor-1",
        reason: "start selection",
        auditContext
      },
      tx
    );

    expect(result.selectionSet.status).toBe("DRAFT");
    expect(tx.drawingSelectionSet.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ code: "SET-001" }) })
    );
    expect(auditSpy).toHaveBeenCalledWith(tx, expect.any(Object));
    expect(outboxSpy).toHaveBeenCalledWith(tx, expect.any(Object));
  });

  it("adds an exact published scanned controlled drawing version and stores server snapshots", async () => {
    const tx = transaction();
    const result = await addDrawingSelectionItem(baseInput, tx);

    expect(result.item).toMatchObject({
      drawingId: "drawing-1",
      documentVersionId: "version-1",
      manufacturingCategoryCodeSnapshot: "MACHINING",
      processTagCodesSnapshotJson: ["MILLING"],
      drawingNumberSnapshot: "DWG-001",
      drawingVersionSnapshot: 7,
      supplierMatchState: "DEFAULT_MATCH"
    });
    expect(tx.drawingSelectionItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ categoryCodeSnapshot: expect.anything() })
      })
    );
    expect(auditSpy).toHaveBeenCalledWith(tx, expect.any(Object));
    expect(outboxSpy).toHaveBeenCalledWith(tx, expect.any(Object));
  });

  it("serializes the added item's required date as a JSON value in the Outbox payload", async () => {
    const tx = transaction();

    await addDrawingSelectionItem(baseInput, tx);

    expect(outboxSpy).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        payload: expect.objectContaining({ requiredOn: "2026-08-30T00:00:00.000Z" })
      })
    );
  });

  it("persists an unassigned NO_MATCH selection item with database NULL capability evidence", async () => {
    const tx = transaction();

    await addDrawingSelectionItem({ ...baseInput, supplierReferenceId: null }, tx);

    const command = tx.drawingSelectionItem.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(command.data.supplierReferenceId).toBeNull();
    expect(command.data.supplierMatchState).toBe("NO_MATCH");
    expect(command.data.supplierCapabilitySnapshotJson).toBe(Prisma.DbNull);
  });

  it.each([
    ["draft", { status: "DRAFT" }],
    ["cross project", { projectId: "project-b" }],
    ["wrong drawing", { documentId: "other-document" }]
  ])("rejects a %s document version", async (_label, overrides) => {
    const tx = transaction({
      controlledDocumentVersion: { findFirst: vi.fn(async () => documentVersion(overrides)) }
    });
    await expect(addDrawingSelectionItem(baseInput, tx)).rejects.toMatchObject({
      code: "DRAWING_SELECTION_VERSION_INVALID"
    });
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("rejects versions whose drawing files are not scanned AVAILABLE CONTROLLED files", async () => {
    const tx = transaction({
      mechanicalDrawingVersionFile: {
        findMany: vi.fn(async () => [
          {
            role: "CAD_SOURCE",
            file: {
              status: "PENDING_SCAN",
              storageArea: "QUARANTINE",
              scannedAt: null,
              sha256: null,
              verifiedMimeType: null,
              verifiedSize: null
            }
          }
        ])
      }
    });
    await expect(addDrawingSelectionItem(baseInput, tx)).rejects.toMatchObject({
      code: "DRAWING_SELECTION_FILES_INVALID"
    });
  });

  it("requires a reason for a same-project non-matching supplier", async () => {
    const tx = transaction({
      supplierReference: { findFirst: vi.fn(async () => supplier()) },
      supplierReferenceManufacturingCapability: { findMany: vi.fn(async () => []) }
    });
    await expect(
      addDrawingSelectionItem({ ...baseInput, exceptionReason: null }, tx)
    ).rejects.toMatchObject({ code: "SUPPLIER_EXCEPTION_REASON_REQUIRED" });
  });

  it("allows an explicitly reasoned supplier exception and records the exception state", async () => {
    const tx = transaction({
      supplierReferenceManufacturingCapability: { findMany: vi.fn(async () => []) }
    });
    const result = await addDrawingSelectionItem(
      { ...baseInput, exceptionReason: "customer nominated supplier" },
      tx
    );
    expect(result.item.supplierMatchState).toBe("EXCEPTION");
    expect(result.item.supplierExceptionReason).toBe("customer nominated supplier");
  });

  it("rejects changes after a selection set is locked", async () => {
    const tx = transaction({
      drawingSelectionSet: { findUnique: vi.fn(async () => selectionSet({ status: "LOCKED" })) }
    });
    await expect(addDrawingSelectionItem(baseInput, tx)).rejects.toMatchObject({
      code: "DRAWING_SELECTION_LOCKED",
      status: 409
    });
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("returns a 409 on stale selection-set version and writes no success side effects", async () => {
    const tx = transaction({
      drawingSelectionSet: { findUnique: vi.fn(async () => selectionSet({ version: 2 })) }
    });
    await expect(addDrawingSelectionItem(baseInput, tx)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      status: 409
    });
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("locks a draft set only after reading its items and advances its version", async () => {
    const tx = transaction();
    const result = await lockDrawingSelectionSet(
      {
        projectId: "project-a",
        selectionSetId: "selection-set-1",
        version: 1,
        actorId: "actor-1",
        reason: "selection reviewed",
        auditContext
      },
      tx
    );
    expect(result.selectionSet.status).toBe("LOCKED");
    expect(tx.drawingSelectionSet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ version: 1 }) })
    );
    expect(auditSpy).toHaveBeenCalledWith(tx, expect.any(Object));
    expect(outboxSpy).toHaveBeenCalledWith(tx, expect.any(Object));
  });

  it("updates a draft item's mutable package fields with optimistic locking", async () => {
    const tx = transaction();
    const result = await updateDrawingSelectionItem(
      {
        projectId: "project-a",
        selectionSetId: "selection-set-1",
        selectionItemId: "selection-item-1",
        quantity: 4,
        spareQuantity: 0,
        requiredOn: new Date("2026-09-01"),
        supplierReferenceId: null,
        purpose: "MANUFACTURING",
        exceptionReason: null,
        version: 1,
        actorId: "actor-1",
        reason: "adjust package quantity",
        auditContext
      },
      tx
    );
    expect(result.item).toBeDefined();
    expect(tx.drawingSelectionItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ version: 1 }) })
    );
  });

  it("serializes the updated item's required date as a JSON value in the Outbox payload", async () => {
    const tx = transaction({
      drawingSelectionItem: {
        findUnique: vi.fn(async () => item({ requiredOn: new Date("2026-09-01") })),
        updateMany: vi.fn(async () => ({ count: 1 }))
      }
    });

    await updateDrawingSelectionItem(
      {
        projectId: "project-a",
        selectionSetId: "selection-set-1",
        selectionItemId: "selection-item-1",
        quantity: 4,
        spareQuantity: 0,
        requiredOn: new Date("2026-09-01"),
        supplierReferenceId: null,
        purpose: "MANUFACTURING",
        exceptionReason: null,
        version: 1,
        actorId: "actor-1",
        reason: "adjust package quantity",
        auditContext
      },
      tx
    );

    expect(outboxSpy).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        payload: expect.objectContaining({ requiredOn: "2026-09-01T00:00:00.000Z" })
      })
    );
  });

  it("reads the selection set and preserves its locked history", async () => {
    const tx = transaction({
      drawingSelectionSet: {
        findUnique: vi.fn(async () => selectionSet({ status: "LOCKED", items: [item()] }))
      }
    });
    await expect(
      getDrawingSelectionSet({ projectId: "project-a", selectionSetId: "selection-set-1" }, tx)
    ).resolves.toMatchObject({ status: "LOCKED", items: [{ id: "selection-item-1" }] });
  });
});
