import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  DRAWING_SELECTION_ITEM_AUDIT_FIELDS,
  DRAWING_SELECTION_SET_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  assertDrawingSelectionPurpose,
  assertSelectionMutable,
  ManufacturingClassificationError,
  normalizeManufacturingCategoryCode,
  normalizeProcessTagCodes,
  validateDrawingSelectionQuantities,
  validateSupplierExceptionReason
} from "../domain/manufacturing-classification";
import { resolveSupplierMatch } from "./supplier-manufacturing-capability-service";

type Client = Prisma.TransactionClient | typeof db;
type AnyRecord = Record<string, any>;

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ManufacturingClassificationError("VERSION_CONFLICT", "version 必须是正整数。", 422);
  }
  return value as number;
}

function requiredText(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new ManufacturingClassificationError(
      "INVALID_NAME",
      `${field}不能为空且不能超过${max}个字符。`,
      422
    );
  }
  return value.trim();
}

function commandReason(value: unknown): string {
  return requiredText(value, "操作原因", 1024);
}

function requiredDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new ManufacturingClassificationError(
      "DRAWING_SELECTION_QUANTITY_INVALID",
      "需求日期无效。",
      422
    );
  }
  return date;
}

function selectionNotFound(): never {
  throw new ManufacturingClassificationError("NOT_FOUND", "选图分包不存在。", 404);
}

function itemNotFound(): never {
  throw new ManufacturingClassificationError("NOT_FOUND", "选图项不存在。", 404);
}

function normalizeSelectionCode(value: unknown): string {
  const code = requiredText(value, "选图分包代码", 64).toUpperCase();
  if (!/^[A-Z][A-Z0-9._-]{0,63}$/u.test(code)) {
    throw new ManufacturingClassificationError("INVALID_CODE", "选图分包代码格式无效。", 422);
  }
  return code;
}

function readItemValue(item: AnyRecord) {
  return {
    projectId: item.projectId,
    selectionSetId: item.selectionSetId,
    selectionItemId: item.id,
    drawingId: item.drawingId,
    documentVersionId: item.documentVersionId,
    drawingNumberSnapshot: item.drawingNumberSnapshot,
    drawingVersionSnapshot: item.drawingVersionSnapshot,
    manufacturingCategoryCodeSnapshot: item.manufacturingCategoryCodeSnapshot,
    processTagCodesSnapshot: item.processTagCodesSnapshotJson,
    quantity: item.quantity?.toString?.() ?? item.quantity,
    spareQuantity: item.spareQuantity?.toString?.() ?? item.spareQuantity,
    requiredOn: item.requiredOn,
    supplierReferenceId: item.supplierReferenceId,
    supplierMatchState: item.supplierMatchState,
    supplierExceptionReason: item.supplierExceptionReason,
    purpose: item.purpose,
    version: item.version
  };
}

function readSetValue(selectionSet: AnyRecord) {
  return {
    projectId: selectionSet.projectId,
    selectionSetId: selectionSet.id,
    code: selectionSet.code,
    title: selectionSet.title,
    status: selectionSet.status,
    version: selectionSet.version,
    itemCount: selectionSet.items?.length ?? 0
  };
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new ManufacturingClassificationError("CODE_CONFLICT", "选图分包或版本已存在。", 409);
    }
    if (error.code === "P2003" || error.code === "P2004") {
      throw new ManufacturingClassificationError("NOT_FOUND", "选图关系无效。", 404);
    }
  }
  throw error;
}

async function lockSelectionSet(client: Client, projectId: string, selectionSetId: string) {
  await client.$queryRaw`
    SELECT "id" FROM "drawing_selection_sets"
    WHERE "id" = ${selectionSetId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  const delegate = client.drawingSelectionSet as any;
  return typeof delegate.findFirst === "function"
    ? delegate.findFirst({ where: { id: selectionSetId, projectId }, include: { items: true } })
    : delegate.findUnique({ where: { id: selectionSetId }, include: { items: true } });
}

async function readSelectionSet(client: Client, projectId: string, selectionSetId: string) {
  const delegate = client.drawingSelectionSet as any;
  return typeof delegate.findFirst === "function"
    ? delegate.findFirst({ where: { id: selectionSetId, projectId }, include: { items: true } })
    : delegate.findUnique({ where: { id: selectionSetId }, include: { items: true } });
}

function assertDraftSet(selectionSet: AnyRecord, expectedVersion: number) {
  assertSelectionMutable(selectionSet.status);
  if (selectionSet.version !== expectedVersion) {
    throw new ManufacturingClassificationError(
      "VERSION_CONFLICT",
      "选图分包已发生变化，请刷新后重试。",
      409
    );
  }
}

async function resolveDrawingVersion(
  client: Client,
  input: {
    projectId: string;
    drawingId: string;
    documentVersionId: string;
  }
) {
  const drawing = await client.mechanicalDrawing.findFirst({
    where: { id: input.drawingId, projectId: input.projectId },
    include: {
      manufacturingCategory: true,
      processTags: { include: { processTag: true } }
    }
  });
  if (!drawing) {
    throw new ManufacturingClassificationError("DRAWING_NOT_FOUND", "机械图纸不存在。", 404);
  }
  if (!drawing.manufacturingCategory) {
    throw new ManufacturingClassificationError(
      "DRAWING_SELECTION_VERSION_INVALID",
      "图纸必须先配置制造分类。",
      409
    );
  }

  const documentVersion = await client.controlledDocumentVersion.findFirst({
    where: {
      id: input.documentVersionId,
      projectId: input.projectId,
      documentId: drawing.documentId,
      status: "PUBLISHED"
    }
  });
  if (
    !documentVersion ||
    documentVersion.projectId !== input.projectId ||
    documentVersion.documentId !== drawing.documentId ||
    documentVersion.status !== "PUBLISHED"
  ) {
    throw new ManufacturingClassificationError(
      "DRAWING_SELECTION_VERSION_INVALID",
      "选图项必须引用当前项目中该图纸的已发布精确版本。",
      409
    );
  }

  const files = await client.mechanicalDrawingVersionFile.findMany({
    where: {
      projectId: input.projectId,
      drawingId: input.drawingId,
      documentVersionId: input.documentVersionId
    },
    include: { file: true }
  });
  if (
    !files.length ||
    files.filter((entry: AnyRecord) => entry.role === "CAD_SOURCE").length !== 1
  ) {
    throw new ManufacturingClassificationError(
      "DRAWING_SELECTION_FILES_INVALID",
      "选图版本必须有且仅有一个 CAD_SOURCE 文件。",
      409
    );
  }
  const invalidFile = files.find((entry: AnyRecord) => {
    const file = entry.file;
    return (
      !file ||
      file.projectId !== input.projectId ||
      file.status !== "AVAILABLE" ||
      file.storageArea !== "CONTROLLED" ||
      !file.scannedAt ||
      !file.sha256 ||
      !file.verifiedMimeType ||
      file.verifiedSize === null ||
      file.verifiedSize === undefined
    );
  });
  if (invalidFile) {
    throw new ManufacturingClassificationError(
      "DRAWING_SELECTION_FILES_INVALID",
      "选图版本文件必须已扫描、可用且位于 CONTROLLED 存储区。",
      409
    );
  }

  const processTagCodes = normalizeProcessTagCodes(
    drawing.processTags.map((link: AnyRecord) => link.processTag.code)
  );
  return {
    drawing,
    documentVersion,
    categoryCode: normalizeManufacturingCategoryCode(drawing.manufacturingCategory.code),
    processTagCodes
  };
}

async function resolveSupplierState(
  client: Client,
  input: {
    projectId: string;
    supplierReferenceId: string | null;
    categoryCode: string;
    processTagCodes: string[];
    exceptionReason: unknown;
  }
) {
  if (!input.supplierReferenceId) {
    return {
      supplierMatchState: "NO_MATCH" as const,
      supplierCapabilitySnapshotJson: null,
      exceptionReason: null
    };
  }
  const supplier = await client.supplierReference.findFirst({
    where: { id: input.supplierReferenceId, projectId: input.projectId }
  });
  if (!supplier) {
    throw new ManufacturingClassificationError(
      "SUPPLIER_REFERENCE_NOT_FOUND",
      "供应商不属于当前项目。",
      404
    );
  }
  if (supplier.status !== "ACTIVE") {
    throw new ManufacturingClassificationError(
      "SUPPLIER_REFERENCE_NOT_FOUND",
      "供应商当前不可用于选图分包。",
      409
    );
  }
  const match = await resolveSupplierMatch(client, {
    projectId: input.projectId,
    supplierReferenceId: input.supplierReferenceId,
    classification: { categoryCode: input.categoryCode, processTagCodes: input.processTagCodes }
  });
  const exceptionReason = validateSupplierExceptionReason({
    supplierReferenceId: input.supplierReferenceId,
    isDefaultMatch: match.isDefault,
    exceptionReason: input.exceptionReason
  });
  if (match.isDefault) {
    return {
      supplierMatchState: "DEFAULT_MATCH" as const,
      supplierCapabilitySnapshotJson: match,
      exceptionReason: null
    };
  }
  return {
    supplierMatchState: "EXCEPTION" as const,
    supplierCapabilitySnapshotJson: match,
    exceptionReason
  };
}

async function writeSetAudit(
  client: Client,
  input: {
    action: keyof typeof AUDIT_ACTIONS;
    objectType: keyof typeof AUDIT_OBJECT_TYPES;
    objectId: string;
    context: AuditContext;
    value: unknown;
    fields: readonly string[];
  }
) {
  const audit = await writeAudit(client, {
    action: AUDIT_ACTIONS[input.action],
    objectType: AUDIT_OBJECT_TYPES[input.objectType],
    objectId: input.objectId,
    context: input.context,
    after: { value: input.value, allowedFields: input.fields }
  });
  return audit;
}

function context(input: {
  auditContext: AuditContext;
  actorId: string;
  projectId: string;
  reason: string;
}): AuditContext {
  return {
    ...input.auditContext,
    actorId: input.actorId,
    projectId: input.projectId,
    reason: input.reason
  };
}

export async function createDrawingSelectionSet(
  input: {
    projectId: string;
    code: unknown;
    title: unknown;
    actorId: string;
    reason: unknown;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const code = normalizeSelectionCode(input.code);
  const title = requiredText(input.title, "选图分包标题");
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const selectionSet = await client.drawingSelectionSet.create({
        data: { projectId: input.projectId, code, title, createdById: input.actorId },
        include: { items: true }
      });
      const value = readSetValue(selectionSet);
      const audit = await writeSetAudit(client, {
        action: "DRAWING_SELECTION_SET_CREATED",
        objectType: "DRAWING_SELECTION_SET",
        objectId: selectionSet.id,
        context: context({ ...input, reason }),
        value,
        fields: DRAWING_SELECTION_SET_AUDIT_FIELDS
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "drawing.selection-set.created",
        aggregateType: AUDIT_OBJECT_TYPES.DRAWING_SELECTION_SET,
        aggregateId: selectionSet.id,
        idempotencyKey: `${selectionSet.id}:v${selectionSet.version}`,
        payload: value
      });
      return {
        selectionSet,
        resourceVersion: selectionSet.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    if (error instanceof ManufacturingClassificationError) throw error;
    mapDatabaseError(error);
  }
}

export async function listDrawingSelectionSets(
  input: { projectId: string },
  transaction?: Prisma.TransactionClient
) {
  const delegate = (transaction ?? db).drawingSelectionSet as any;
  return delegate.findMany({
    where: { projectId: input.projectId },
    include: { items: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
}

export async function getDrawingSelectionSet(
  input: { projectId: string; selectionSetId: string },
  transaction?: Prisma.TransactionClient
) {
  const selectionSet = await readSelectionSet(
    transaction ?? db,
    input.projectId,
    input.selectionSetId
  );
  if (!selectionSet) selectionNotFound();
  return selectionSet;
}

export async function addDrawingSelectionItem(
  input: {
    projectId: string;
    selectionSetId: string;
    drawingId: string;
    documentVersionId: string;
    quantity: unknown;
    spareQuantity: unknown;
    requiredOn: unknown;
    supplierReferenceId: string | null;
    purpose: unknown;
    exceptionReason: unknown;
    version: unknown;
    actorId: string;
    reason: unknown;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  const quantities = validateDrawingSelectionQuantities({
    quantity: input.quantity,
    spareQuantity: input.spareQuantity
  });
  const requiredOn = requiredDate(input.requiredOn);
  const purpose = assertDrawingSelectionPurpose(input.purpose);
  try {
    return await inTransaction(transaction, async (client) => {
      const selectionSet = await lockSelectionSet(client, input.projectId, input.selectionSetId);
      if (!selectionSet) selectionNotFound();
      assertDraftSet(selectionSet, expectedVersion);
      const target = await resolveDrawingVersion(client, input);
      const supplierState = await resolveSupplierState(client, {
        projectId: input.projectId,
        supplierReferenceId: input.supplierReferenceId,
        categoryCode: target.categoryCode,
        processTagCodes: target.processTagCodes,
        exceptionReason: input.exceptionReason
      });
      const created = await client.drawingSelectionItem.create({
        data: {
          projectId: input.projectId,
          selectionSetId: input.selectionSetId,
          drawingId: input.drawingId,
          documentVersionId: input.documentVersionId,
          manufacturingCategoryCodeSnapshot: target.categoryCode,
          processTagCodesSnapshotJson: target.processTagCodes,
          drawingNumberSnapshot: target.drawing.drawingNumber,
          drawingVersionSnapshot: target.documentVersion.version,
          quantity: new Prisma.Decimal(quantities.quantity),
          spareQuantity: new Prisma.Decimal(quantities.spareQuantity),
          requiredOn,
          supplierReferenceId: input.supplierReferenceId,
          purpose,
          supplierMatchState: supplierState.supplierMatchState,
          supplierExceptionReason: supplierState.exceptionReason,
          supplierCapabilitySnapshotJson:
            supplierState.supplierCapabilitySnapshotJson === null
              ? Prisma.DbNull
              : (supplierState.supplierCapabilitySnapshotJson as Prisma.InputJsonValue),
          createdById: input.actorId
        }
      });
      const updatedSet = await client.drawingSelectionSet.updateMany({
        where: {
          id: selectionSet.id,
          projectId: input.projectId,
          version: expectedVersion,
          status: "DRAFT"
        },
        data: { version: { increment: 1 } }
      });
      if (updatedSet.count !== 1) {
        throw new ManufacturingClassificationError(
          "VERSION_CONFLICT",
          "选图分包已发生变化，请刷新后重试。",
          409
        );
      }
      const itemValue = readItemValue(created);
      const audit = await writeSetAudit(client, {
        action: "DRAWING_SELECTION_ITEM_ADDED",
        objectType: "DRAWING_SELECTION_ITEM",
        objectId: created.id,
        context: context({ ...input, reason }),
        value: itemValue,
        fields: DRAWING_SELECTION_ITEM_AUDIT_FIELDS
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "drawing.selection-item.added",
        aggregateType: AUDIT_OBJECT_TYPES.DRAWING_SELECTION_SET,
        aggregateId: selectionSet.id,
        idempotencyKey: `${selectionSet.id}:item:${created.id}:v${selectionSet.version + 1}`,
        payload: itemValue
      });
      return {
        item: created,
        resourceVersion: selectionSet.version + 1,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    if (error instanceof ManufacturingClassificationError) throw error;
    mapDatabaseError(error);
  }
}

export async function updateDrawingSelectionItem(
  input: {
    projectId: string;
    selectionSetId: string;
    selectionItemId: string;
    quantity: unknown;
    spareQuantity: unknown;
    requiredOn: unknown;
    supplierReferenceId: string | null;
    purpose: unknown;
    exceptionReason: unknown;
    version: unknown;
    actorId: string;
    reason: unknown;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  const quantities = validateDrawingSelectionQuantities({
    quantity: input.quantity,
    spareQuantity: input.spareQuantity
  });
  const requiredOn = requiredDate(input.requiredOn);
  const purpose = assertDrawingSelectionPurpose(input.purpose);
  try {
    return await inTransaction(transaction, async (client) => {
      const selectionSet = await lockSelectionSet(client, input.projectId, input.selectionSetId);
      if (!selectionSet) selectionNotFound();
      assertSelectionMutable(selectionSet.status);
      const itemDelegate = client.drawingSelectionItem as any;
      const item = await (typeof itemDelegate.findFirst === "function"
        ? itemDelegate.findFirst({
            where: {
              id: input.selectionItemId,
              projectId: input.projectId,
              selectionSetId: input.selectionSetId
            }
          })
        : itemDelegate.findUnique({ where: { id: input.selectionItemId } }));
      if (!item) itemNotFound();
      if (item.version !== expectedVersion) {
        throw new ManufacturingClassificationError(
          "VERSION_CONFLICT",
          "选图项已发生变化，请刷新后重试。",
          409
        );
      }
      const supplierState = await resolveSupplierState(client, {
        projectId: input.projectId,
        supplierReferenceId: input.supplierReferenceId,
        categoryCode: normalizeManufacturingCategoryCode(item.manufacturingCategoryCodeSnapshot),
        processTagCodes: normalizeProcessTagCodes(item.processTagCodesSnapshotJson),
        exceptionReason: input.exceptionReason
      });
      const updated = await client.drawingSelectionItem.updateMany({
        where: {
          id: item.id,
          projectId: input.projectId,
          selectionSetId: input.selectionSetId,
          version: expectedVersion
        },
        data: {
          quantity: new Prisma.Decimal(quantities.quantity),
          spareQuantity: new Prisma.Decimal(quantities.spareQuantity),
          requiredOn,
          supplierReferenceId: input.supplierReferenceId,
          purpose,
          supplierMatchState: supplierState.supplierMatchState,
          supplierExceptionReason: supplierState.exceptionReason,
          supplierCapabilitySnapshotJson:
            supplierState.supplierCapabilitySnapshotJson === null
              ? Prisma.DbNull
              : (supplierState.supplierCapabilitySnapshotJson as Prisma.InputJsonValue),
          version: { increment: 1 }
        }
      });
      if (updated.count !== 1) {
        throw new ManufacturingClassificationError(
          "VERSION_CONFLICT",
          "选图项已发生变化，请刷新后重试。",
          409
        );
      }
      const refreshed = await client.drawingSelectionItem.findUnique({ where: { id: item.id } });
      if (!refreshed) itemNotFound();
      const itemValue = readItemValue(refreshed);
      const audit = await writeSetAudit(client, {
        action: "DRAWING_SELECTION_ITEM_UPDATED",
        objectType: "DRAWING_SELECTION_ITEM",
        objectId: item.id,
        context: context({ ...input, reason }),
        value: itemValue,
        fields: DRAWING_SELECTION_ITEM_AUDIT_FIELDS
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "drawing.selection-item.updated",
        aggregateType: AUDIT_OBJECT_TYPES.DRAWING_SELECTION_ITEM,
        aggregateId: item.id,
        idempotencyKey: `${item.id}:v${item.version + 1}`,
        payload: itemValue
      });
      return {
        item: refreshed,
        resourceVersion: item.version + 1,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    if (error instanceof ManufacturingClassificationError) throw error;
    mapDatabaseError(error);
  }
}

export async function lockDrawingSelectionSet(
  input: {
    projectId: string;
    selectionSetId: string;
    version: unknown;
    actorId: string;
    reason: unknown;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const selectionSet = await lockSelectionSet(client, input.projectId, input.selectionSetId);
      if (!selectionSet) selectionNotFound();
      assertSelectionMutable(selectionSet.status);
      if (selectionSet.version !== expectedVersion) {
        throw new ManufacturingClassificationError(
          "VERSION_CONFLICT",
          "选图分包已发生变化，请刷新后重试。",
          409
        );
      }
      const updated = await client.drawingSelectionSet.updateMany({
        where: {
          id: selectionSet.id,
          projectId: input.projectId,
          version: expectedVersion,
          status: "DRAFT"
        },
        data: { status: "LOCKED", version: { increment: 1 } }
      });
      if (updated.count !== 1) {
        throw new ManufacturingClassificationError(
          "VERSION_CONFLICT",
          "选图分包已发生变化，请刷新后重试。",
          409
        );
      }
      const refreshed = await client.drawingSelectionSet.findUnique({
        where: { id: selectionSet.id },
        include: { items: true }
      });
      if (!refreshed) selectionNotFound();
      const lockedSelectionSet = {
        ...refreshed,
        status: "LOCKED",
        version: refreshed.version ?? expectedVersion + 1
      };
      const value = readSetValue(lockedSelectionSet);
      const audit = await writeSetAudit(client, {
        action: "DRAWING_SELECTION_SET_LOCKED",
        objectType: "DRAWING_SELECTION_SET",
        objectId: lockedSelectionSet.id,
        context: context({ ...input, reason }),
        value,
        fields: DRAWING_SELECTION_SET_AUDIT_FIELDS
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "drawing.selection-set.locked",
        aggregateType: AUDIT_OBJECT_TYPES.DRAWING_SELECTION_SET,
        aggregateId: lockedSelectionSet.id,
        idempotencyKey: `${lockedSelectionSet.id}:v${lockedSelectionSet.version}`,
        payload: value
      });
      return {
        selectionSet: lockedSelectionSet,
        resourceVersion: lockedSelectionSet.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    if (error instanceof ManufacturingClassificationError) throw error;
    mapDatabaseError(error);
  }
}
