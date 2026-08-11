import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  DRAWING_CLASSIFICATION_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import { assertProjectWritableById } from "@/modules/projects/domain/project-write-policy";

import {
  ManufacturingClassificationError,
  normalizeManufacturingCategoryCode,
  normalizeProcessTagCodes
} from "../domain/manufacturing-classification";

type CategoryRow = {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  version: number;
};

type TagRow = CategoryRow;

type DrawingLink = {
  id: string;
  projectId: string;
  drawingId: string;
  processTagId: string;
  processTag: TagRow;
};

type DrawingRow = {
  id: string;
  projectId: string;
  drawingNumber: string;
  drawingType: string;
  manufacturingCategoryId: string | null;
  version: number;
  manufacturingCategory: CategoryRow | null;
  processTags: DrawingLink[];
};

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ManufacturingClassificationError("VERSION_CONFLICT", "version 必须是正整数。", 422);
  }
  return value as number;
}

function reason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new ManufacturingClassificationError(
      "INVALID_NAME",
      "操作原因必须是 1 到 1024 个字符。",
      422
    );
  }
  return value.trim();
}

function categoryValue(category: CategoryRow | null) {
  return category
    ? {
        id: category.id,
        code: category.code,
        name: category.name,
        sortOrder: category.sortOrder,
        isActive: category.isActive,
        version: category.version
      }
    : null;
}

function tagValue(tag: TagRow) {
  return {
    id: tag.id,
    code: tag.code,
    name: tag.name,
    sortOrder: tag.sortOrder,
    isActive: tag.isActive,
    version: tag.version
  };
}

function classificationValue(drawing: DrawingRow) {
  const processTags = drawing.processTags
    .map(({ processTag }) => tagValue(processTag))
    .sort((left, right) => left.code.localeCompare(right.code));
  const category = categoryValue(drawing.manufacturingCategory);
  return {
    drawingId: drawing.id,
    projectId: drawing.projectId,
    drawingNumber: drawing.drawingNumber,
    drawingType: drawing.drawingType,
    version: drawing.version,
    resourceVersion: drawing.version,
    category,
    processTags,
    classification: { category, processTags }
  };
}

async function readDrawing(
  client: Prisma.TransactionClient | typeof db,
  projectId: string,
  drawingId: string
) {
  return client.mechanicalDrawing.findFirst({
    where: { projectId, id: drawingId },
    include: {
      manufacturingCategory: true,
      processTags: {
        include: { processTag: true },
        orderBy: { processTag: { code: "asc" } }
      }
    }
  }) as Promise<DrawingRow | null>;
}

export async function getDrawingClassification(
  input: { projectId: string; drawingId: string },
  transaction?: Prisma.TransactionClient
) {
  const drawing = await readDrawing(transaction ?? db, input.projectId, input.drawingId);
  if (!drawing) {
    throw new ManufacturingClassificationError("DRAWING_NOT_FOUND", "机械图纸不存在。", 404);
  }
  return classificationValue(drawing);
}

function inactiveAssignment<T extends { id: string; code: string; isActive: boolean }>(
  candidate: T,
  currentIds: ReadonlySet<string>,
  label: string
) {
  if (!candidate.isActive && !currentIds.has(candidate.id)) {
    throw new ManufacturingClassificationError(
      "INACTIVE_CLASSIFICATION",
      `${label} ${candidate.code} 已停用，不能用于新的图纸分类。`,
      409
    );
  }
}

function distinctIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ManufacturingClassificationError(
      "PROCESS_TAG_CODE_INVALID",
      "工艺标签必须是 ID 数组。",
      422
    );
  }
  const ids = value.map((item) => item.trim());
  if (new Set(ids).size !== ids.length) {
    throw new ManufacturingClassificationError("PROCESS_TAG_DUPLICATE", "工艺标签不能重复。", 409);
  }
  return ids;
}

export async function updateDrawingClassification(
  input: {
    projectId: string;
    drawingId: string;
    categoryId?: string | null;
    manufacturingCategoryId?: string | null;
    categoryCode?: unknown;
    processTagIds?: unknown;
    processTagCodes?: unknown;
    version: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = positiveVersion(input.version);
  const changeReason = reason(input.reason);
  const requestedCategoryId = input.categoryId ?? input.manufacturingCategoryId ?? null;
  const requestedCategoryCode =
    requestedCategoryId === null && input.categoryCode !== undefined
      ? normalizeManufacturingCategoryCode(input.categoryCode)
      : null;
  const requestedTagIds =
    input.processTagIds !== undefined ? distinctIds(input.processTagIds) : null;
  const requestedTagCodes =
    requestedTagIds === null && input.processTagCodes !== undefined
      ? normalizeProcessTagCodes(input.processTagCodes)
      : null;
  if (requestedCategoryId === null && requestedCategoryCode === null) {
    throw new ManufacturingClassificationError(
      "MANUFACTURING_CATEGORY_NOT_FOUND",
      "图纸必须配置制造分类。",
      422
    );
  }
  if (requestedTagIds === null && requestedTagCodes === null) {
    throw new ManufacturingClassificationError(
      "PROCESS_TAG_CODE_INVALID",
      "工艺标签必须是 ID 或代码数组。",
      422
    );
  }

  return inTransaction(transaction, async (client) => {
    await assertProjectWritableById(client, input.projectId);
    await client.$queryRaw`
      SELECT "id" FROM "mechanical_drawings"
      WHERE "id" = ${input.drawingId} AND "project_id" = ${input.projectId}
      FOR UPDATE
    `;
    const drawing = await readDrawing(client, input.projectId, input.drawingId);
    if (!drawing) {
      throw new ManufacturingClassificationError("DRAWING_NOT_FOUND", "机械图纸不存在。", 404);
    }
    if (drawing.version !== expectedVersion) {
      throw new ManufacturingClassificationError(
        "VERSION_CONFLICT",
        "图纸分类已发生变化，请刷新后重试。",
        409
      );
    }

    const category = await client.manufacturingCategory.findUnique({
      where:
        requestedCategoryId !== null
          ? { id: requestedCategoryId }
          : { code: requestedCategoryCode! }
    });
    if (!category) {
      throw new ManufacturingClassificationError(
        "MANUFACTURING_CATEGORY_NOT_FOUND",
        "制造分类不存在。",
        404
      );
    }
    const currentCategoryId = drawing.manufacturingCategoryId;
    if (!category.isActive && category.id !== currentCategoryId) {
      throw new ManufacturingClassificationError(
        "INACTIVE_CLASSIFICATION",
        `制造分类 ${category.code} 已停用，不能用于新的图纸分类。`,
        409
      );
    }

    const tags =
      requestedTagIds !== null
        ? await client.processTag.findMany({ where: { id: { in: requestedTagIds } } })
        : await client.processTag.findMany({ where: { code: { in: requestedTagCodes! } } });
    const requestedCount = requestedTagIds?.length ?? requestedTagCodes?.length ?? 0;
    if (tags.length !== requestedCount) {
      throw new ManufacturingClassificationError("PROCESS_TAG_NOT_FOUND", "工艺标签不存在。", 404);
    }
    const currentTagIds = new Set(drawing.processTags.map(({ processTagId }) => processTagId));
    for (const tag of tags) inactiveAssignment(tag, currentTagIds, "工艺标签");
    if (tags.some((tag) => !tag.isActive && !currentTagIds.has(tag.id))) {
      throw new ManufacturingClassificationError(
        "INACTIVE_CLASSIFICATION",
        "停用工艺标签不能用于新的图纸分类。",
        409
      );
    }

    const updated = await client.mechanicalDrawing.updateMany({
      where: { id: input.drawingId, projectId: input.projectId, version: expectedVersion },
      data: { manufacturingCategoryId: category.id, version: { increment: 1 } }
    });
    if (updated.count !== 1) {
      throw new ManufacturingClassificationError(
        "VERSION_CONFLICT",
        "图纸分类已发生变化，请刷新后重试。",
        409
      );
    }

    const targetTagIds = new Set(tags.map(({ id }) => id));
    await client.mechanicalDrawingProcessTag.deleteMany({
      where: {
        projectId: input.projectId,
        drawingId: input.drawingId,
        processTagId: { notIn: [...targetTagIds] }
      }
    });
    const additions = tags
      .filter((tag) => !currentTagIds.has(tag.id))
      .map((tag) => ({
        projectId: input.projectId,
        drawingId: input.drawingId,
        processTagId: tag.id
      }));
    if (additions.length) await client.mechanicalDrawingProcessTag.createMany({ data: additions });

    const refreshed = await readDrawing(client, input.projectId, input.drawingId);
    if (!refreshed) throw new Error("更新后的图纸分类无法读取。");
    const beforeValue = {
      projectId: drawing.projectId,
      drawingId: drawing.id,
      categoryCode: drawing.manufacturingCategory?.code ?? null,
      processTagCodes: drawing.processTags.map(({ processTag }) => processTag.code),
      version: drawing.version
    };
    const afterValue = {
      projectId: refreshed.projectId,
      drawingId: refreshed.id,
      categoryCode: refreshed.manufacturingCategory?.code ?? null,
      processTagCodes: refreshed.processTags.map(({ processTag }) => processTag.code),
      version: refreshed.version
    };
    const context = {
      ...input.auditContext,
      actorId: input.actorId,
      projectId: input.projectId,
      reason: changeReason
    };
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.MECHANICAL_DRAWING_CLASSIFICATION_UPDATED,
      objectType: AUDIT_OBJECT_TYPES.MECHANICAL_DRAWING,
      objectId: refreshed.id,
      context,
      before: { value: beforeValue, allowedFields: DRAWING_CLASSIFICATION_AUDIT_FIELDS },
      after: { value: afterValue, allowedFields: DRAWING_CLASSIFICATION_AUDIT_FIELDS }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "drawing.classification.updated",
      aggregateType: AUDIT_OBJECT_TYPES.MECHANICAL_DRAWING,
      aggregateId: refreshed.id,
      idempotencyKey: `${refreshed.id}:classification:v${refreshed.version}`,
      payload: afterValue
    });
    return { ...classificationValue(refreshed), auditId: audit.id, outboxEventId: outbox.id };
  });
}

export function assertActiveManufacturingCategory(category: { code: string; isActive: boolean }) {
  if (!category.isActive) {
    throw new ManufacturingClassificationError(
      "MANUFACTURING_CATEGORY_INACTIVE",
      `制造分类 ${category.code} 已停用。`,
      409
    );
  }
}

export function assertActiveProcessTags(tags: ReadonlyArray<{ code: string; isActive: boolean }>) {
  const inactive = tags.find((tag) => !tag.isActive);
  if (inactive) {
    throw new ManufacturingClassificationError(
      "PROCESS_TAG_INACTIVE",
      `工艺标签 ${inactive.code} 已停用。`,
      409
    );
  }
}

export function buildDrawingClassificationSnapshot(input: {
  category: CategoryRow;
  processTags: TagRow[];
}) {
  return {
    category: categoryValue(input.category),
    processTags: [...input.processTags]
      .sort((left, right) => left.code.localeCompare(right.code))
      .map(tagValue)
  };
}
