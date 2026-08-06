import { Prisma, ProjectStatus } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  PROCUREMENT_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import {
  ERP_OWNED_FIELDS,
  type ProcurementProjectionEnvelope,
  type ProcurementSourcePort
} from "@/modules/procurement/contracts/procurement-source";
import { deriveProcurementDisplayStatus } from "@/modules/procurement/domain/procurement-status";

export class ProcurementTrackingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "ProcurementTrackingError";
  }
}

type TrackingDate = string | null | undefined;

export type CreateProcurementTrackingLineInput = {
  projectId: string;
  requirementId: string;
  requirementRevisionId: string;
  supplierReferenceId?: string | null;
  responsibleMembershipId?: string | null;
  businessType: "STANDARD_PURCHASE" | "DRAWING_CUSTOM" | "OUTSOURCED_PROCESS";
  orderedQuantity: string;
  requisitionObjectType?: string | null;
  requisitionExternalId?: string | null;
  requisitionExternalLineId?: string | null;
  orderObjectType?: string | null;
  orderExternalId?: string | null;
  orderExternalLineId?: string | null;
  orderedOn?: TrackingDate;
  promisedOn?: TrackingDate;
  supplierConfirmationStatus?: string | null;
  externalStatus?: string | null;
  actorId: string;
  auditContext: AuditContext;
  reason: string;
};

export type UpdateLocalProcurementTrackingLineInput = Omit<
  CreateProcurementTrackingLineInput,
  "requirementId" | "requirementRevisionId" | "businessType" | "actorId" | "orderedQuantity"
> & {
  trackingLineId: string;
  version: number;
  actorId: string;
  orderedQuantity?: string;
};

function requiredText(value: unknown, field: string, max = 191): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > max) {
    throw new ProcurementTrackingError("PROC_INVALID_INPUT", `${field} 必须是有效字符串。`, 422);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, max = 191): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, field, max);
}

function dateValue(value: TrackingDate, field: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new ProcurementTrackingError("PROC_INVALID_INPUT", `${field} 必须是 YYYY-MM-DD。`, 422);
  }
  return new Date(`${value}T00:00:00.000Z`);
}

function quantity(value: unknown): Prisma.Decimal {
  const text = requiredText(value, "orderedQuantity", 32);
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u.test(text) || new Prisma.Decimal(text).lte(0)) {
    throw new ProcurementTrackingError(
      "PROC_QUANTITY_INVALID",
      "orderedQuantity 必须是正数。",
      422
    );
  }
  return new Prisma.Decimal(text);
}

function compareSourceVersion(left: string, right: string): number {
  if (/^\d+$/u.test(left) && /^\d+$/u.test(right)) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a > b ? 1 : -1;
  }
  return left === right ? 0 : left > right ? 1 : -1;
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProcurementTrackingError("PROC_INVALID_VERSION", "version 必须是正整数。", 422);
  }
  return value as number;
}

function projectInput(projectId: unknown): string {
  return requiredText(projectId, "projectId");
}

async function assertWritableProject(client: Prisma.TransactionClient, projectId: string) {
  const [project, settings] = await Promise.all([
    client.project.findUnique({ where: { id: projectId }, select: { id: true, status: true } }),
    client.projectProcurementSettings.findUnique({ where: { projectId } })
  ]);
  if (!project) throw new ProcurementTrackingError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  if (project.status === ProjectStatus.CLOSED || project.status === ProjectStatus.CANCELED) {
    throw new ProcurementTrackingError(
      "PROJECT_READ_ONLY",
      "已关闭或取消项目不能修改采购跟踪。",
      409
    );
  }
  if (!settings) {
    throw new ProcurementTrackingError("PROC_SETTINGS_REQUIRED", "项目尚未配置采购运行模式。", 409);
  }
  return settings;
}

async function assertProjectRelations(
  client: Prisma.TransactionClient,
  input: Pick<
    CreateProcurementTrackingLineInput,
    | "projectId"
    | "requirementId"
    | "requirementRevisionId"
    | "supplierReferenceId"
    | "responsibleMembershipId"
  > & { businessType?: CreateProcurementTrackingLineInput["businessType"] }
) {
  const revision = await client.projectMaterialRequirementRevision.findFirst({
    where: {
      id: input.requirementRevisionId,
      projectId: input.projectId,
      requirementId: input.requirementId
    },
    select: { id: true, requirementId: true, projectId: true, businessType: true }
  });
  if (!revision) {
    throw new ProcurementTrackingError(
      "PROC_REQUIREMENT_NOT_FOUND",
      "需求或需求修订不属于当前项目。",
      404
    );
  }
  if (input.businessType && revision.businessType !== input.businessType) {
    throw new ProcurementTrackingError(
      "PROC_BUSINESS_TYPE_MISMATCH",
      "跟踪行业务类型必须与需求修订一致。",
      422
    );
  }
  if (input.supplierReferenceId) {
    const supplier = await client.supplierReference.findFirst({
      where: { id: input.supplierReferenceId, projectId: input.projectId },
      select: { id: true }
    });
    if (!supplier)
      throw new ProcurementTrackingError("PROC_SUPPLIER_NOT_FOUND", "供应商不属于当前项目。", 404);
  }
  if (input.responsibleMembershipId) {
    const membership = await client.projectMember.findFirst({
      where: { id: input.responsibleMembershipId, projectId: input.projectId, leftAt: null },
      select: { id: true }
    });
    if (!membership)
      throw new ProcurementTrackingError("PROC_MEMBER_NOT_FOUND", "负责人不是当前项目成员。", 404);
  }
}

function lineData(input: CreateProcurementTrackingLineInput) {
  return {
    projectId: projectInput(input.projectId),
    requirementId: requiredText(input.requirementId, "requirementId"),
    requirementRevisionId: requiredText(input.requirementRevisionId, "requirementRevisionId"),
    supplierReferenceId: optionalText(input.supplierReferenceId, "supplierReferenceId"),
    responsibleMembershipId: optionalText(input.responsibleMembershipId, "responsibleMembershipId"),
    businessType: input.businessType,
    source: "LOCAL" as const,
    requisitionObjectType: optionalText(input.requisitionObjectType, "requisitionObjectType"),
    requisitionExternalId: optionalText(input.requisitionExternalId, "requisitionExternalId"),
    requisitionExternalLineId: optionalText(
      input.requisitionExternalLineId,
      "requisitionExternalLineId"
    ),
    orderObjectType: optionalText(input.orderObjectType, "orderObjectType"),
    orderExternalId: optionalText(input.orderExternalId, "orderExternalId"),
    orderExternalLineId: optionalText(input.orderExternalLineId, "orderExternalLineId"),
    orderedQuantity: quantity(input.orderedQuantity),
    orderedOn: dateValue(input.orderedOn, "orderedOn"),
    promisedOn: dateValue(input.promisedOn, "promisedOn"),
    supplierConfirmationStatus: optionalText(
      input.supplierConfirmationStatus,
      "supplierConfirmationStatus"
    ),
    externalStatus: optionalText(input.externalStatus, "externalStatus"),
    version: 1,
    createdById: requiredText(input.actorId, "actorId"),
    updatedById: requiredText(input.actorId, "actorId")
  };
}

function auditValue(line: {
  id: string;
  projectId: string;
  requirementId: string;
  requirementRevisionId: string;
  responsibleMembershipId: string | null;
  orderedQuantity: Prisma.Decimal;
  promisedOn: Date | null;
  source: string;
  version: number;
}) {
  return {
    projectId: line.projectId,
    trackingLineId: line.id,
    requirementId: line.requirementId,
    revisionId: line.requirementRevisionId,
    responsibleMembershipId: line.responsibleMembershipId,
    quantity: line.orderedQuantity.toString(),
    promisedOn: line.promisedOn?.toISOString().slice(0, 10) ?? null,
    source: line.source,
    version: line.version
  };
}

async function recordTrackingChange(
  client: Prisma.TransactionClient,
  input: {
    action: "created" | "updated" | "projected";
    line: Parameters<typeof auditValue>[0];
    context: AuditContext;
    reason: string;
  }
) {
  const action =
    input.action === "created"
      ? AUDIT_ACTIONS.PROCUREMENT_TRACKING_CREATED
      : input.action === "updated"
        ? AUDIT_ACTIONS.PROCUREMENT_TRACKING_UPDATED
        : AUDIT_ACTIONS.PROCUREMENT_TRACKING_PROJECTED;
  const audit = await writeAudit(client, {
    action,
    objectType: AUDIT_OBJECT_TYPES.PROCUREMENT_TRACKING_LINE,
    objectId: input.line.id,
    context: { ...input.context, projectId: input.line.projectId, reason: input.reason },
    after: { value: auditValue(input.line), allowedFields: PROCUREMENT_AUDIT_FIELDS }
  });
  const event = await appendOutboxEvent(client, {
    eventType: `procurement.tracking.${input.action}`,
    aggregateType: "PROCUREMENT_TRACKING_LINE",
    aggregateId: input.line.id,
    idempotencyKey: `${input.line.id}:v${input.line.version}:${input.action}`,
    payload: {
      trackingLineId: input.line.id,
      projectId: input.line.projectId,
      version: input.line.version,
      auditId: audit.id
    }
  });
  return { auditId: audit.id, outboxEventId: event.id };
}

export async function createProcurementTrackingLine(
  input: CreateProcurementTrackingLineInput,
  transaction?: Prisma.TransactionClient
) {
  return inTransaction(transaction, async (client) => {
    const data = lineData(input);
    const settings = await assertWritableProject(client, data.projectId);
    if (settings.mode !== "LOCAL") {
      throw new ProcurementTrackingError(
        "PROC_ERP_FIELD_READ_ONLY",
        "ERP 模式跟踪行必须通过只读投影写入。",
        409
      );
    }
    await assertProjectRelations(client, data);
    const line = await client.procurementTrackingLine.create({ data });
    const recorded = await recordTrackingChange(client, {
      action: "created",
      line,
      context: input.auditContext,
      reason: input.reason
    });
    return { line, ...recorded };
  });
}

export async function updateLocalProcurementTrackingLine(
  input: UpdateLocalProcurementTrackingLineInput,
  transaction?: Prisma.TransactionClient
) {
  return inTransaction(transaction, async (client) => {
    const projectId = projectInput(input.projectId);
    const trackingLineId = requiredText(input.trackingLineId, "trackingLineId");
    const current = await client.procurementTrackingLine.findFirst({
      where: { id: trackingLineId, projectId }
    });
    if (!current)
      throw new ProcurementTrackingError("PROC_TRACKING_NOT_FOUND", "采购跟踪行不存在。", 404);
    if (current.source !== "LOCAL")
      throw new ProcurementTrackingError(
        "PROC_ERP_FIELD_READ_ONLY",
        "ERP 跟踪行不可由本地命令修改。",
        409
      );
    if (current.version !== version(input.version))
      throw new ProcurementTrackingError("VERSION_CONFLICT", "采购跟踪行版本已变化。", 409);
    await assertWritableProject(client, projectId);
    await assertProjectRelations(client, {
      ...input,
      requirementId: current.requirementId,
      requirementRevisionId: current.requirementRevisionId
    });
    const line = await client.procurementTrackingLine.update({
      where: { id: current.id },
      data: {
        supplierReferenceId:
          input.supplierReferenceId === undefined
            ? current.supplierReferenceId
            : optionalText(input.supplierReferenceId, "supplierReferenceId"),
        responsibleMembershipId:
          input.responsibleMembershipId === undefined
            ? current.responsibleMembershipId
            : optionalText(input.responsibleMembershipId, "responsibleMembershipId"),
        orderedQuantity:
          input.orderedQuantity === undefined
            ? current.orderedQuantity
            : quantity(input.orderedQuantity),
        requisitionObjectType:
          input.requisitionObjectType === undefined
            ? current.requisitionObjectType
            : optionalText(input.requisitionObjectType, "requisitionObjectType"),
        requisitionExternalId:
          input.requisitionExternalId === undefined
            ? current.requisitionExternalId
            : optionalText(input.requisitionExternalId, "requisitionExternalId"),
        requisitionExternalLineId:
          input.requisitionExternalLineId === undefined
            ? current.requisitionExternalLineId
            : optionalText(input.requisitionExternalLineId, "requisitionExternalLineId"),
        orderObjectType:
          input.orderObjectType === undefined
            ? current.orderObjectType
            : optionalText(input.orderObjectType, "orderObjectType"),
        orderExternalId:
          input.orderExternalId === undefined
            ? current.orderExternalId
            : optionalText(input.orderExternalId, "orderExternalId"),
        orderExternalLineId:
          input.orderExternalLineId === undefined
            ? current.orderExternalLineId
            : optionalText(input.orderExternalLineId, "orderExternalLineId"),
        promisedOn:
          input.promisedOn === undefined
            ? current.promisedOn
            : dateValue(input.promisedOn, "promisedOn"),
        orderedOn:
          input.orderedOn === undefined
            ? current.orderedOn
            : dateValue(input.orderedOn, "orderedOn"),
        supplierConfirmationStatus:
          input.supplierConfirmationStatus === undefined
            ? current.supplierConfirmationStatus
            : optionalText(input.supplierConfirmationStatus, "supplierConfirmationStatus"),
        externalStatus:
          input.externalStatus === undefined
            ? current.externalStatus
            : optionalText(input.externalStatus, "externalStatus"),
        version: { increment: 1 },
        updatedById: requiredText(input.actorId, "actorId")
      }
    });
    const recorded = await recordTrackingChange(client, {
      action: "updated",
      line,
      context: input.auditContext,
      reason: input.reason
    });
    return { line, ...recorded };
  });
}

function payloadText(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return value === undefined || value === null ? null : requiredText(value, key);
}

export async function applyErpTrackingProjection(
  input: {
    projectId: string;
    actorId: string;
    auditContext: AuditContext;
    reason: string;
    envelope: ProcurementProjectionEnvelope;
    source: ProcurementSourcePort;
  },
  transaction?: Prisma.TransactionClient
) {
  return inTransaction(transaction, async (client) => {
    const settings = await assertWritableProject(client, projectInput(input.projectId));
    if (settings.mode !== "ERP")
      throw new ProcurementTrackingError("PROC_LOCAL_MODE_ONLY", "项目当前不是 ERP 模式。", 409);
    const accepted = await input.source.upsertProjection(input.envelope);
    const requirementId = payloadText(input.envelope.payload, "requirementId");
    const requirementRevisionId = payloadText(input.envelope.payload, "requirementRevisionId");
    if (!requirementId || !requirementRevisionId)
      throw new ProcurementTrackingError(
        "PROC_REQUIREMENT_MAPPING_REQUIRED",
        "ERP 投影必须包含项目需求映射。",
        422
      );
    const businessType = (payloadText(input.envelope.payload, "businessType") ??
      "STANDARD_PURCHASE") as CreateProcurementTrackingLineInput["businessType"];
    await assertProjectRelations(client, {
      projectId: input.projectId,
      requirementId,
      requirementRevisionId,
      supplierReferenceId: payloadText(input.envelope.payload, "supplierReferenceId"),
      responsibleMembershipId: payloadText(input.envelope.payload, "responsibleMembershipId"),
      businessType
    });
    const key = {
      sourceSystem_objectType_externalId_externalLineId: {
        sourceSystem: input.envelope.sourceSystem,
        objectType: input.envelope.objectType,
        externalId: input.envelope.externalId,
        externalLineId: input.envelope.externalLineId
      }
    };
    const existingMapping = await client.externalMapping.findUnique({ where: key });
    if (existingMapping && existingMapping.projectId !== input.projectId) {
      throw new ProcurementTrackingError(
        "PROC_EXTERNAL_MAPPING_PROJECT_CONFLICT",
        "外部对象已绑定其他项目。",
        409
      );
    }
    if (existingMapping) {
      const order = compareSourceVersion(
        input.envelope.sourceVersion,
        existingMapping.sourceVersion ?? ""
      );
      if (order < 0) {
        throw new ProcurementTrackingError(
          "PROC_SOURCE_VERSION_OUT_OF_ORDER",
          "ERP 投影版本早于当前水位。",
          409
        );
      }
      if (order === 0 && existingMapping.sourceHash !== input.envelope.sourceHash) {
        throw new ProcurementTrackingError(
          "PROC_SOURCE_VERSION_CONFLICT",
          "相同 ERP 版本绑定了不同内容。",
          409
        );
      }
    }
    if (
      existingMapping?.sourceVersion === input.envelope.sourceVersion &&
      existingMapping.sourceHash === input.envelope.sourceHash
    )
      return { accepted: true, idempotent: true, projection: accepted };
    const existing = await client.procurementTrackingLine.findFirst({
      where: {
        projectId: input.projectId,
        source: "ERP",
        orderExternalId: input.envelope.externalId,
        orderExternalLineId: input.envelope.externalLineId
      }
    });
    const commonData = {
      projectId: input.projectId,
      requirementId,
      requirementRevisionId,
      supplierReferenceId: payloadText(input.envelope.payload, "supplierReferenceId"),
      responsibleMembershipId: payloadText(input.envelope.payload, "responsibleMembershipId"),
      businessType,
      source: "ERP" as const,
      orderObjectType: input.envelope.objectType,
      orderExternalId: input.envelope.externalId,
      orderExternalLineId: input.envelope.externalLineId,
      orderedQuantity: quantity(payloadText(input.envelope.payload, "orderedQuantity") ?? "0"),
      promisedOn: dateValue(payloadText(input.envelope.payload, "promisedOn"), "promisedOn"),
      externalStatus: payloadText(input.envelope.payload, "externalStatus"),
      sourceVersion: input.envelope.sourceVersion,
      sourceHash: input.envelope.sourceHash,
      syncedAt: new Date(input.envelope.occurredAt),
      createdById: input.actorId,
      updatedById: input.actorId
    };
    const line = existing
      ? await client.procurementTrackingLine.update({
          where: { id: existing.id },
          data: { ...commonData, version: { increment: 1 } }
        })
      : await client.procurementTrackingLine.create({ data: { ...commonData, version: 1 } });
    await client.externalMapping.upsert({
      where: key,
      create: {
        sourceSystem: input.envelope.sourceSystem,
        objectType: input.envelope.objectType,
        externalId: input.envelope.externalId,
        externalLineId: input.envelope.externalLineId,
        apmObjectType: "PROCUREMENT_TRACKING_LINE",
        apmObjectId: line.id,
        projectId: input.projectId,
        sourceVersion: input.envelope.sourceVersion,
        sourceHash: input.envelope.sourceHash,
        syncedAt: new Date(input.envelope.occurredAt)
      },
      update: {
        sourceVersion: input.envelope.sourceVersion,
        sourceHash: input.envelope.sourceHash,
        syncedAt: new Date(input.envelope.occurredAt),
        version: { increment: 1 }
      }
    });
    const recorded = await recordTrackingChange(client, {
      action: "projected",
      line,
      context: input.auditContext,
      reason: input.reason
    });
    return { line, ...recorded, accepted: true, idempotent: false };
  });
}

export async function listProcurementTrackingLines(input: {
  projectId: string;
  limit?: number;
  cursor?: string;
}) {
  const projectId = projectInput(input.projectId);
  const rows = await db.procurementTrackingLine.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(input.limit ?? 50, 1), 100),
    ...(input.cursor ? { skip: 1, cursor: { id: input.cursor } } : {}),
    include: { requirementRevision: { select: { status: true, quantity: true } } }
  });
  return {
    items: rows.map((line) => ({
      id: line.id,
      projectId: line.projectId,
      requirementId: line.requirementId,
      requirementRevisionId: line.requirementRevisionId,
      source: line.source,
      sourceWatermark: line.sourceVersion,
      syncedAt: line.syncedAt?.toISOString() ?? null,
      isStale: line.source === "ERP" && !line.syncedAt,
      orderedQuantity: line.orderedQuantity.toString(),
      promisedOn: line.promisedOn?.toISOString().slice(0, 10) ?? null,
      displayStatus: deriveProcurementDisplayStatus({
        requirementStatus: line.requirementRevision.status,
        requiredQuantity: line.requirementRevision.quantity.toString(),
        orderedQuantity: line.orderedQuantity.toString()
      })
    })),
    nextCursor:
      rows.length === Math.min(Math.max(input.limit ?? 50, 1), 100)
        ? (rows.at(-1)?.id ?? null)
        : null
  };
}

export const ERP_TRACKING_READ_ONLY_FIELDS = ERP_OWNED_FIELDS;
