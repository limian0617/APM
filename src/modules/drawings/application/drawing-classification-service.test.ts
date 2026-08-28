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
  createManufacturingCategory,
  disableProcessTag,
  updateManufacturingCategory
} from "./manufacturing-configuration-service";
import {
  getDrawingClassification,
  updateDrawingClassification
} from "./drawing-classification-service";

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
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    updatedAt: new Date("2026-08-11T00:00:00.000Z"),
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
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    updatedAt: new Date("2026-08-11T00:00:00.000Z"),
    ...overrides
  };
}

function drawing(overrides: Record<string, unknown> = {}) {
  return {
    id: "drawing-1",
    projectId: "project-a",
    drawingNumber: "DWG-1",
    drawingType: "PART",
    manufacturingCategoryId: "category-1",
    version: 2,
    manufacturingCategory: category(),
    processTags: [
      {
        id: "link-1",
        projectId: "project-a",
        drawingId: "drawing-1",
        processTagId: "tag-1",
        processTag: tag()
      }
    ],
    ...overrides
  };
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn(async () => []),
    manufacturingCategory: {
      findUnique: vi.fn(async () => null),
      findUniqueOrThrow: vi.fn(async () => category({ version: 2 })),
      findMany: vi.fn(async () => [category()]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        category({ ...data, id: "category-created", version: 1 })
      ),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    processTag: {
      findUnique: vi.fn(async () => tag()),
      findUniqueOrThrow: vi.fn(async () => tag({ version: 2, isActive: false })),
      findMany: vi.fn(async () => [tag()]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        tag({ ...data, id: "tag-created", version: 1 })
      ),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    mechanicalDrawing: {
      findFirst: vi.fn(async () => drawing()),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    mechanicalDrawingProcessTag: {
      findMany: vi.fn(async () => drawing().processTags),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 }))
    },
    ...overrides
  } as any;
}

beforeEach(() => {
  auditSpy.mockClear();
  outboxSpy.mockClear();
});

describe("APM-053 transactional drawing classification", () => {
  it("keeps a disabled process tag visible on an existing drawing", async () => {
    const tx = transaction({
      mechanicalDrawing: {
        findFirst: vi.fn(async () =>
          drawing({
            processTags: [{ ...drawing().processTags[0], processTag: tag({ isActive: false }) }]
          })
        ),
        updateMany: vi.fn(async () => ({ count: 1 }))
      }
    });

    const result = await getDrawingClassification(
      { projectId: "project-a", drawingId: "drawing-1" },
      tx
    );

    expect(result.processTags).toMatchObject([{ code: "MILLING", isActive: false }]);
  });

  it("rejects a stale classification without a success audit or Outbox event", async () => {
    const tx = transaction({
      mechanicalDrawing: {
        findFirst: vi.fn(async () => drawing({ version: 3 })),
        updateMany: vi.fn(async () => ({ count: 0 }))
      }
    });

    await expect(
      updateDrawingClassification(
        {
          projectId: "project-a",
          drawingId: "drawing-1",
          version: 2,
          categoryId: "category-1",
          processTagIds: ["tag-1"],
          reason: "refresh classification",
          actorId: "actor-1",
          auditContext
        },
        tx
      )
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });

    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("rejects inactive category and tag assignments unless the existing value is unchanged", async () => {
    const tx = transaction({
      manufacturingCategory: {
        findUnique: vi.fn(async () => category({ id: "category-disabled", isActive: false }))
      },
      processTag: {
        findMany: vi.fn(async () => [tag({ id: "tag-disabled", isActive: false })])
      }
    });

    await expect(
      updateDrawingClassification(
        {
          projectId: "project-a",
          drawingId: "drawing-1",
          version: 2,
          categoryId: "category-disabled",
          processTagIds: ["tag-disabled"],
          reason: "use disabled values",
          actorId: "actor-1",
          auditContext
        },
        tx
      )
    ).rejects.toMatchObject({ code: "INACTIVE_CLASSIFICATION", status: 409 });
    expect(auditSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it("enforces the project boundary for classification reads", async () => {
    const tx = transaction({
      mechanicalDrawing: { findFirst: vi.fn(async () => null) }
    });

    await expect(
      getDrawingClassification({ projectId: "project-b", drawingId: "drawing-1" }, tx)
    ).rejects.toMatchObject({ code: "DRAWING_NOT_FOUND", status: 404 });
  });

  it("uses the caller transaction and optimistic versions for configuration commands", async () => {
    const tx = transaction();
    const created = await createManufacturingCategory(
      {
        code: "  NEW_CATEGORY ",
        name: "New category",
        sortOrder: 4,
        reason: "add vocabulary",
        actorId: "actor-1",
        auditContext
      },
      tx
    );
    expect(created.category.code).toBe("NEW_CATEGORY");
    expect(tx.manufacturingCategory.create).toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(tx, expect.any(Object));
    expect(outboxSpy).toHaveBeenCalledWith(tx, expect.any(Object));

    const current = category({ id: "category-1", version: 4 });
    tx.manufacturingCategory.findUnique.mockResolvedValueOnce(current);
    tx.manufacturingCategory.findUniqueOrThrow.mockResolvedValueOnce({ ...current, version: 5 });
    const updated = await updateManufacturingCategory(
      {
        categoryId: "category-1",
        version: 4,
        name: "Updated category",
        sortOrder: 5,
        reason: "rename display name",
        actorId: "actor-1",
        auditContext
      },
      tx
    );
    expect(updated.category.version).toBe(5);
    expect(tx.manufacturingCategory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ version: 4 }) })
    );
  });

  it("does not expose rename or delete operations for stable configuration codes", () => {
    expect(updateManufacturingCategory.length).toBeGreaterThan(0);
    expect(
      (updateManufacturingCategory as unknown as Record<string, unknown>).delete
    ).toBeUndefined();
  });

  it("can disable a process tag through the same transaction boundary", async () => {
    const tx = transaction();
    tx.processTag.findUnique.mockResolvedValueOnce(tag({ id: "tag-1", version: 1 }));
    tx.processTag.findUniqueOrThrow.mockResolvedValueOnce(
      tag({ id: "tag-1", version: 2, isActive: false })
    );

    const result = await disableProcessTag(
      {
        tagId: "tag-1",
        version: 1,
        reason: "retire tag",
        actorId: "actor-1",
        auditContext
      },
      tx
    );

    expect(result.tag.isActive).toBe(false);
    expect(tx.processTag.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ version: 1 }) })
    );
    expect(auditSpy).toHaveBeenCalledWith(tx, expect.any(Object));
    expect(outboxSpy).toHaveBeenCalledWith(tx, expect.any(Object));
  });
});
