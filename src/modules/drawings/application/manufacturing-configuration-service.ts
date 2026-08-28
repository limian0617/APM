import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  DRAWING_CONFIGURATION_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  ManufacturingClassificationError,
  normalizeManufacturingCategoryCode,
  normalizeProcessTagCode
} from "../domain/manufacturing-classification";

export type ManufacturingConfigurationKind = "CATEGORY" | "PROCESS_TAG";

type ConfigurationRow = {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  version: number;
};

type ConfigurationDelegate = {
  findMany(args: unknown): Promise<ConfigurationRow[]>;
  findUnique(args: unknown): Promise<ConfigurationRow | null>;
  findUniqueOrThrow(args: unknown): Promise<ConfigurationRow>;
  create(args: unknown): Promise<ConfigurationRow>;
  updateMany(args: unknown): Promise<{ count: number }>;
};

function delegate(
  client: Prisma.TransactionClient | typeof db,
  kind: ManufacturingConfigurationKind
) {
  return (kind === "CATEGORY"
    ? client.manufacturingCategory
    : client.processTag) as unknown as ConfigurationDelegate;
}

function code(kind: ManufacturingConfigurationKind, value: unknown): string {
  return kind === "CATEGORY"
    ? normalizeManufacturingCategoryCode(value)
    : normalizeProcessTagCode(value);
}

function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 191) {
    throw new ManufacturingClassificationError("INVALID_NAME", "名称必须是 1 到 191 个字符。", 422);
  }
  return value.trim();
}

function sortOrder(value: unknown): number {
  const normalized = value === undefined ? 0 : value;
  if (!Number.isSafeInteger(normalized) || (normalized as number) < 0) {
    throw new ManufacturingClassificationError("INVALID_SORT_ORDER", "排序必须是非负整数。", 422);
  }
  return normalized as number;
}

function version(value: unknown): number {
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

function notFound(kind: ManufacturingConfigurationKind): never {
  throw new ManufacturingClassificationError(
    kind === "CATEGORY" ? "MANUFACTURING_CATEGORY_NOT_FOUND" : "PROCESS_TAG_NOT_FOUND",
    "制造分类配置不存在。",
    404
  );
}

function auditAction(
  kind: ManufacturingConfigurationKind,
  operation: "created" | "updated" | "statusChanged"
) {
  if (kind === "CATEGORY") {
    return operation === "created"
      ? AUDIT_ACTIONS.MANUFACTURING_CATEGORY_CREATED
      : operation === "statusChanged"
        ? AUDIT_ACTIONS.MANUFACTURING_CATEGORY_STATUS_CHANGED
        : AUDIT_ACTIONS.MANUFACTURING_CATEGORY_UPDATED;
  }
  return operation === "created"
    ? AUDIT_ACTIONS.PROCESS_TAG_CREATED
    : operation === "statusChanged"
      ? AUDIT_ACTIONS.PROCESS_TAG_STATUS_CHANGED
      : AUDIT_ACTIONS.PROCESS_TAG_UPDATED;
}

function objectType(kind: ManufacturingConfigurationKind) {
  return kind === "CATEGORY"
    ? AUDIT_OBJECT_TYPES.MANUFACTURING_CATEGORY
    : AUDIT_OBJECT_TYPES.PROCESS_TAG;
}

function eventPrefix(kind: ManufacturingConfigurationKind) {
  return kind === "CATEGORY" ? "manufacturing-category" : "process-tag";
}

function rowValue(row: ConfigurationRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    version: row.version
  };
}

async function createConfiguration(
  input: {
    kind: ManufacturingConfigurationKind;
    code: unknown;
    name: unknown;
    sortOrder?: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const normalizedCode = code(input.kind, input.code);
  const normalizedName = name(input.name);
  const normalizedSortOrder = sortOrder(input.sortOrder);
  const normalizedReason = reason(input.reason);
  return inTransaction(transaction, async (client) => {
    try {
      const model = delegate(client, input.kind);
      const row = await model.create({
        data: {
          code: normalizedCode,
          name: normalizedName,
          sortOrder: normalizedSortOrder,
          isActive: true
        }
      });
      const context = { ...input.auditContext, actorId: input.actorId, reason: normalizedReason };
      const audit = await writeAudit(client, {
        action: auditAction(input.kind, "created"),
        objectType: objectType(input.kind),
        objectId: row.id,
        context,
        after: { value: rowValue(row), allowedFields: DRAWING_CONFIGURATION_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: `drawing.${eventPrefix(input.kind)}.created`,
        aggregateType: objectType(input.kind),
        aggregateId: row.id,
        idempotencyKey: `${row.id}:v${row.version}`,
        payload: rowValue(row)
      });
      return { row, auditId: audit.id, outboxEventId: event.id };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ManufacturingClassificationError("CODE_CONFLICT", "稳定代码已存在。", 409);
      }
      throw error;
    }
  });
}

async function updateConfiguration(
  input: {
    kind: ManufacturingConfigurationKind;
    id: string;
    code?: unknown;
    version: unknown;
    name: unknown;
    sortOrder: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = version(input.version);
  const normalizedName = name(input.name);
  const normalizedSortOrder = sortOrder(input.sortOrder);
  const normalizedReason = reason(input.reason);
  return inTransaction(transaction, async (client) => {
    const model = delegate(client, input.kind);
    const current = await model.findUnique({ where: { id: input.id } });
    if (!current) notFound(input.kind);
    if (input.code !== undefined && code(input.kind, input.code) !== current.code) {
      throw new ManufacturingClassificationError("CODE_IMMUTABLE", "稳定代码创建后不可修改。", 409);
    }
    if (current.version !== expectedVersion) {
      throw new ManufacturingClassificationError(
        "VERSION_CONFLICT",
        "配置已发生变化，请刷新后重试。",
        409
      );
    }
    const updated = await model.updateMany({
      where: { id: input.id, version: expectedVersion },
      data: { name: normalizedName, sortOrder: normalizedSortOrder, version: { increment: 1 } }
    });
    if (updated.count !== 1) {
      throw new ManufacturingClassificationError(
        "VERSION_CONFLICT",
        "配置已发生变化，请刷新后重试。",
        409
      );
    }
    const row = await model.findUniqueOrThrow({ where: { id: input.id } });
    const context = { ...input.auditContext, actorId: input.actorId, reason: normalizedReason };
    const audit = await writeAudit(client, {
      action: auditAction(input.kind, "updated"),
      objectType: objectType(input.kind),
      objectId: row.id,
      context,
      before: { value: rowValue(current), allowedFields: DRAWING_CONFIGURATION_AUDIT_FIELDS },
      after: { value: rowValue(row), allowedFields: DRAWING_CONFIGURATION_AUDIT_FIELDS }
    });
    const event = await appendOutboxEvent(client, {
      eventType: `drawing.${eventPrefix(input.kind)}.updated`,
      aggregateType: objectType(input.kind),
      aggregateId: row.id,
      idempotencyKey: `${row.id}:v${row.version}`,
      payload: rowValue(row)
    });
    return { row, auditId: audit.id, outboxEventId: event.id };
  });
}

async function setStatus(
  input: {
    kind: ManufacturingConfigurationKind;
    id: string;
    version: unknown;
    enabled: boolean;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = version(input.version);
  const normalizedReason = reason(input.reason);
  return inTransaction(transaction, async (client) => {
    const model = delegate(client, input.kind);
    const current = await model.findUnique({ where: { id: input.id } });
    if (!current) notFound(input.kind);
    if (current.version !== expectedVersion) {
      throw new ManufacturingClassificationError(
        "VERSION_CONFLICT",
        "配置已发生变化，请刷新后重试。",
        409
      );
    }
    if (current.isActive === input.enabled) {
      return { row: current, repeated: true, auditId: null, outboxEventId: null };
    }
    const updated = await model.updateMany({
      where: { id: input.id, version: expectedVersion },
      data: { isActive: input.enabled, version: { increment: 1 } }
    });
    if (updated.count !== 1) {
      throw new ManufacturingClassificationError(
        "VERSION_CONFLICT",
        "配置已发生变化，请刷新后重试。",
        409
      );
    }
    const row = await model.findUniqueOrThrow({ where: { id: input.id } });
    const context = { ...input.auditContext, actorId: input.actorId, reason: normalizedReason };
    const audit = await writeAudit(client, {
      action: auditAction(input.kind, "statusChanged"),
      objectType: objectType(input.kind),
      objectId: row.id,
      context,
      before: { value: rowValue(current), allowedFields: DRAWING_CONFIGURATION_AUDIT_FIELDS },
      after: { value: rowValue(row), allowedFields: DRAWING_CONFIGURATION_AUDIT_FIELDS }
    });
    const event = await appendOutboxEvent(client, {
      eventType: `drawing.${eventPrefix(input.kind)}.status-changed`,
      aggregateType: objectType(input.kind),
      aggregateId: row.id,
      idempotencyKey: `${row.id}:v${row.version}`,
      payload: rowValue(row)
    });
    return { row, repeated: false, auditId: audit.id, outboxEventId: event.id };
  });
}

export async function listManufacturingConfiguration(
  input: { kind: ManufacturingConfigurationKind; activeOnly?: boolean },
  transaction?: Prisma.TransactionClient
) {
  const model = delegate(transaction ?? db, input.kind);
  return model.findMany({
    where: input.activeOnly ? { isActive: true } : undefined,
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }]
  });
}

export function listManufacturingCategories(
  input: { activeOnly?: boolean } = {},
  transaction?: Prisma.TransactionClient
) {
  return listManufacturingConfiguration(
    { kind: "CATEGORY", activeOnly: input.activeOnly },
    transaction
  );
}

export function listProcessTags(
  input: { activeOnly?: boolean } = {},
  transaction?: Prisma.TransactionClient
) {
  return listManufacturingConfiguration(
    { kind: "PROCESS_TAG", activeOnly: input.activeOnly },
    transaction
  );
}

export function createManufacturingConfiguration(
  input: {
    kind: ManufacturingConfigurationKind;
    code: unknown;
    name: unknown;
    sortOrder?: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  return createConfiguration(input, transaction);
}

export function createManufacturingCategory(
  input: Omit<Parameters<typeof createConfiguration>[0], "kind">,
  transaction?: Prisma.TransactionClient
) {
  return createConfiguration({ ...input, kind: "CATEGORY" }, transaction).then(
    ({ row, ...rest }) => ({
      category: row,
      ...rest
    })
  );
}

export function createProcessTag(
  input: Omit<Parameters<typeof createConfiguration>[0], "kind">,
  transaction?: Prisma.TransactionClient
) {
  return createConfiguration({ ...input, kind: "PROCESS_TAG" }, transaction).then(
    ({ row, ...rest }) => ({
      tag: row,
      ...rest
    })
  );
}

export function updateManufacturingCategory(
  input: Omit<Parameters<typeof updateConfiguration>[0], "kind" | "id"> & { categoryId: string },
  transaction?: Prisma.TransactionClient
) {
  return updateConfiguration(
    { ...input, kind: "CATEGORY", id: input.categoryId },
    transaction
  ).then(({ row, ...rest }) => ({
    category: row,
    ...rest
  }));
}

export function updateProcessTag(
  input: Omit<Parameters<typeof updateConfiguration>[0], "kind" | "id"> & { tagId: string },
  transaction?: Prisma.TransactionClient
) {
  return updateConfiguration({ ...input, kind: "PROCESS_TAG", id: input.tagId }, transaction).then(
    ({ row, ...rest }) => ({
      tag: row,
      ...rest
    })
  );
}

export function setManufacturingCategoryEnabled(
  input: Omit<Parameters<typeof setStatus>[0], "kind" | "id"> & { categoryId: string },
  transaction?: Prisma.TransactionClient
) {
  return setStatus({ ...input, kind: "CATEGORY", id: input.categoryId }, transaction).then(
    ({ row, ...rest }) => ({
      category: row,
      ...rest
    })
  );
}

export function setProcessTagEnabled(
  input: Omit<Parameters<typeof setStatus>[0], "kind" | "id"> & { tagId: string },
  transaction?: Prisma.TransactionClient
) {
  return setStatus({ ...input, kind: "PROCESS_TAG", id: input.tagId }, transaction).then(
    ({ row, ...rest }) => ({
      tag: row,
      ...rest
    })
  );
}

export function disableManufacturingCategory(
  input: Omit<Parameters<typeof setManufacturingCategoryEnabled>[0], "enabled">,
  transaction?: Prisma.TransactionClient
) {
  return setManufacturingCategoryEnabled({ ...input, enabled: false }, transaction);
}

export function disableProcessTag(
  input: Omit<Parameters<typeof setProcessTagEnabled>[0], "enabled">,
  transaction?: Prisma.TransactionClient
) {
  return setProcessTagEnabled({ ...input, enabled: false }, transaction);
}

export function enableManufacturingCategory(
  input: Omit<Parameters<typeof setManufacturingCategoryEnabled>[0], "enabled">,
  transaction?: Prisma.TransactionClient
) {
  return setManufacturingCategoryEnabled({ ...input, enabled: true }, transaction);
}

export function enableProcessTag(
  input: Omit<Parameters<typeof setProcessTagEnabled>[0], "enabled">,
  transaction?: Prisma.TransactionClient
) {
  return setProcessTagEnabled({ ...input, enabled: true }, transaction);
}
