import {
  Prisma,
  ProjectStatus,
  type ProcurementBusinessType,
  type ProcurementFulfillmentEventType,
  type ProcurementSource
} from "@prisma/client";

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
  deriveAutoUsableEvent,
  FulfillmentEventError,
  selectFulfillmentReversalEventIds,
  type FulfillmentEventType,
  validateFulfillmentEvent
} from "@/modules/procurement/domain/fulfillment-event";

export class FulfillmentEventServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "FulfillmentEventServiceError";
  }
}

export type AppendFulfillmentEventInput = {
  projectId: unknown;
  requirementId: unknown;
  requirementRevisionId: unknown;
  trackingLineId?: unknown;
  eventType: FulfillmentEventType;
  quantity: unknown;
  trackingUnit: unknown;
  businessOccurredAt: unknown;
  source?: ProcurementSource;
  externalEventKey?: unknown;
  externalDocumentRef?: unknown;
  evidenceFileId?: unknown;
  reason: unknown;
  actorId: string;
  auditContext: AuditContext;
  // APM-091B will provide this only from a published readiness-policy version.
  readinessPolicy?: { arrivalAutoUsable: boolean; inspectionRequired: boolean };
};

export type ReverseFulfillmentEventInput = {
  projectId: unknown;
  eventId: unknown;
  version: unknown;
  reason: unknown;
  actorId: string;
  auditContext: AuditContext;
};

export type FulfillmentEventQuery = {
  projectId: string;
  requirementId?: string;
  cursor?: string;
  limit: number;
};

type FulfillmentEventPage = {
  events: Awaited<ReturnType<typeof db.procurementFulfillmentEvent.findMany>>;
  nextCursor: string | null;
};

type ValidRequirement = Prisma.ProjectMaterialRequirementGetPayload<{
  include: { currentRevision: true };
}>;

type EventTotals = {
  arrivedQuantity: string;
  returnedQuantity: string;
  acceptedQuantity: string;
  rejectedQuantity: string;
  usableQuantity: string;
};

const eventTypeSet = new Set<FulfillmentEventType>([
  "PURCHASE_ARRIVED",
  "OUTSOURCED_DISPATCHED",
  "OUTSOURCED_COMPLETED",
  "OUTSOURCED_RETURNED",
  "ACCEPTED",
  "MARKED_USABLE",
  "REJECTED",
  "RETURNED",
  "REVERSED"
]);
const receiptEventTypes = new Set<FulfillmentEventType>([
  "PURCHASE_ARRIVED",
  "OUTSOURCED_DISPATCHED",
  "OUTSOURCED_COMPLETED",
  "OUTSOURCED_RETURNED"
]);

function text(value: unknown, field: string, maximum = 191): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new FulfillmentEventServiceError(
      "PROC_INVALID_INPUT",
      `${field} 必须是 1 到 ${maximum} 个字符。`
    );
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maximum = 191): string | null {
  if (value === undefined || value === null || value === "") return null;
  return text(value, field, maximum);
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new FulfillmentEventServiceError("PROC_INVALID_VERSION", "version 必须是正整数。", 422);
  }
  return value as number;
}

function eventType(value: unknown): FulfillmentEventType {
  if (typeof value !== "string" || !eventTypeSet.has(value as FulfillmentEventType)) {
    throw new FulfillmentEventServiceError(
      "PROC_EVENT_TYPE_INVALID",
      "eventType 不是受控履约事件类型。"
    );
  }
  return value as FulfillmentEventType;
}

function source(value: unknown): ProcurementSource {
  if (value === undefined) return "LOCAL";
  if (value !== "LOCAL" && value !== "ERP") {
    throw new FulfillmentEventServiceError("PROC_INVALID_INPUT", "source 必须为 LOCAL 或 ERP。");
  }
  return value;
}

function occurredAt(value: unknown): Date {
  if (typeof value !== "string" || !value.trim()) {
    throw new FulfillmentEventServiceError(
      "PROC_INVALID_INPUT",
      "businessOccurredAt 必须是 ISO 时间。",
      422
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
    throw new FulfillmentEventServiceError(
      "PROC_INVALID_INPUT",
      "businessOccurredAt 必须是 ISO 时间。",
      422
    );
  }
  return parsed;
}

function toMicro(value: Prisma.Decimal): bigint {
  const [whole, decimal = ""] = value.toFixed(6).split(".");
  return BigInt(whole) * 1_000_000n + BigInt(decimal.padEnd(6, "0"));
}

function fromMicro(value: bigint): string {
  const negative = value < 0n;
  const normalized = negative ? -value : value;
  const whole = normalized / 1_000_000n;
  const decimal = (normalized % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${decimal ? `.${decimal}` : ""}`;
}

function projectAuditContext(
  input: { auditContext: AuditContext; actorId: string },
  project: { id: string; departmentId: string | null },
  reason: string
) {
  return {
    ...input.auditContext,
    actorId: input.actorId,
    projectId: project.id,
    departmentId: project.departmentId,
    reason
  };
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

async function lockRequirement(
  client: Prisma.TransactionClient,
  projectId: string,
  requirementId: string
): Promise<ValidRequirement> {
  await client.$queryRaw`
    SELECT "id" FROM "project_material_requirements"
    WHERE "id" = ${requirementId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  const requirement = await client.projectMaterialRequirement.findFirst({
    where: { id: requirementId, projectId },
    include: { currentRevision: true }
  });
  if (!requirement) {
    throw new FulfillmentEventServiceError(
      "PROC_REQUIREMENT_NOT_FOUND",
      "物料需求不存在或不属于当前项目。",
      404
    );
  }
  return requirement;
}

async function assertWritableContext(client: Prisma.TransactionClient, projectId: string) {
  const [project, capability, companyCapability, settings] = await Promise.all([
    client.project.findUnique({ where: { id: projectId } }),
    client.projectCapability.findUnique({
      where: {
        projectId_capabilityCode: { projectId, capabilityCode: "PROCUREMENT_COLLABORATION" }
      }
    }),
    client.companyCapability.findUnique({ where: { code: "PROCUREMENT_COLLABORATION" } }),
    client.projectProcurementSettings.findUnique({ where: { projectId } })
  ]);
  if (!project) {
    throw new FulfillmentEventServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  }
  if (project.status === ProjectStatus.CLOSED || project.status === ProjectStatus.CANCELED) {
    throw new FulfillmentEventServiceError(
      "PROJECT_READ_ONLY",
      "已关闭或取消项目不能记录履约事实。",
      409
    );
  }
  if (!companyCapability?.enabled || !capability?.selectedEnabled) {
    throw new FulfillmentEventServiceError(
      "PROC_CAPABILITY_DISABLED",
      "项目采购与物料协同能力未有效启用。",
      409
    );
  }
  if (!settings) {
    throw new FulfillmentEventServiceError(
      "PROC_SETTINGS_NOT_CONFIGURED",
      "项目采购运行模式尚未配置。",
      409
    );
  }
  return { project, settings };
}

function assertCurrentConfirmedRevision(
  requirement: ValidRequirement,
  revisionId: string
): NonNullable<ValidRequirement["currentRevision"]> {
  if (
    requirement.status !== "CONFIRMED" ||
    !requirement.currentRevision ||
    requirement.currentRevision.id !== revisionId ||
    requirement.currentRevision.status !== "CONFIRMED"
  ) {
    throw new FulfillmentEventServiceError(
      "PROC_REQUIREMENT_REVISION_INVALID",
      "履约事件只能记录在当前已确认的需求修订上。",
      409
    );
  }
  return requirement.currentRevision;
}

async function assertTrackingLine(
  client: Prisma.TransactionClient,
  input: {
    projectId: string;
    requirementId: string;
    requirementRevisionId: string;
    trackingLineId: string | null;
  },
  businessType: ProcurementBusinessType
) {
  if (!input.trackingLineId) return null;
  const line = await client.procurementTrackingLine.findFirst({
    where: {
      id: input.trackingLineId,
      projectId: input.projectId,
      requirementId: input.requirementId,
      requirementRevisionId: input.requirementRevisionId
    },
    select: { id: true, businessType: true }
  });
  if (!line || line.businessType !== businessType) {
    throw new FulfillmentEventServiceError(
      "PROC_TRACKING_LINE_NOT_FOUND",
      "采购跟踪行不存在或不属于当前需求修订。",
      422
    );
  }
  return line;
}

async function assertEvidenceFile(
  client: Prisma.TransactionClient,
  projectId: string,
  evidenceFileId: string | null
) {
  if (!evidenceFileId) return null;
  const file = await client.fileObject.findFirst({
    where: { id: evidenceFileId, projectId, status: "AVAILABLE" },
    select: { id: true }
  });
  if (!file) {
    throw new FulfillmentEventServiceError(
      "PROC_EVIDENCE_FILE_INVALID",
      "证据文件不存在、不可用或不属于当前项目。",
      422
    );
  }
  return file;
}

async function loadEffectiveEventTotals(
  client: Prisma.TransactionClient,
  projectId: string,
  requirementId: string,
  requirementRevisionId: string
): Promise<EventTotals> {
  const events = await client.procurementFulfillmentEvent.findMany({
    where: { projectId, requirementId, requirementRevisionId },
    select: {
      eventType: true,
      quantity: true,
      reversedBy: { select: { id: true } }
    }
  });
  const totals = {
    arrived: 0n,
    returned: 0n,
    accepted: 0n,
    rejected: 0n,
    usable: 0n
  };
  for (const event of events) {
    if (event.reversedBy || event.eventType === "REVERSED") continue;
    const quantity = toMicro(event.quantity);
    switch (event.eventType) {
      case "PURCHASE_ARRIVED":
      case "OUTSOURCED_RETURNED":
        totals.arrived += quantity;
        break;
      case "RETURNED":
        totals.returned += quantity;
        break;
      case "ACCEPTED":
        totals.accepted += quantity;
        break;
      case "REJECTED":
        totals.rejected += quantity;
        break;
      case "MARKED_USABLE":
        totals.usable += quantity;
        break;
    }
  }
  return {
    arrivedQuantity: fromMicro(totals.arrived),
    returnedQuantity: fromMicro(totals.returned),
    acceptedQuantity: fromMicro(totals.accepted),
    rejectedQuantity: fromMicro(totals.rejected),
    usableQuantity: fromMicro(totals.usable)
  };
}

function fulfillmentAuditValue(
  event: {
    id: string;
    projectId: string;
    requirementId: string;
    requirementRevisionId: string;
    trackingLineId: string | null;
    eventType: ProcurementFulfillmentEventType;
    quantity: Prisma.Decimal;
    trackingUnit: string;
    businessOccurredAt: Date;
    recordedAt: Date;
    source: ProcurementSource;
    externalEventKey: string | null;
    externalDocumentRef: string | null;
    evidenceFileId: string | null;
    reversesEventId: string | null;
    derivedFromEventId: string | null;
    reason: string;
  },
  version: number
) {
  return {
    projectId: event.projectId,
    fulfillmentEventId: event.id,
    requirementId: event.requirementId,
    revisionId: event.requirementRevisionId,
    trackingLineId: event.trackingLineId,
    eventType: event.eventType,
    quantity: event.quantity.toString(),
    trackingUnit: event.trackingUnit,
    businessOccurredAt: event.businessOccurredAt.toISOString(),
    recordedAt: event.recordedAt.toISOString(),
    source: event.source,
    externalEventKey: event.externalEventKey,
    externalDocumentRef: event.externalDocumentRef,
    evidenceFileId: event.evidenceFileId,
    reversesEventId: event.reversesEventId,
    derivedFromEventId: event.derivedFromEventId,
    reason: event.reason,
    version
  };
}

async function recordEventChange(
  client: Prisma.TransactionClient,
  input: {
    action: "recorded" | "reversed";
    event: Parameters<typeof fulfillmentAuditValue>[0];
    resourceVersion: number;
    auditContext: AuditContext;
    actorId: string;
    project: { id: string; departmentId: string | null };
  }
) {
  const value = fulfillmentAuditValue(input.event, input.resourceVersion);
  const audit = await writeAudit(client, {
    action:
      input.action === "recorded"
        ? AUDIT_ACTIONS.PROCUREMENT_FULFILLMENT_RECORDED
        : AUDIT_ACTIONS.PROCUREMENT_FULFILLMENT_REVERSED,
    objectType: AUDIT_OBJECT_TYPES.PROCUREMENT_FULFILLMENT_EVENT,
    objectId: input.event.id,
    context: projectAuditContext(input, input.project, input.event.reason),
    after: { value, allowedFields: PROCUREMENT_AUDIT_FIELDS }
  });
  const outbox = await appendOutboxEvent(client, {
    eventType: "procurement.fulfillment.changed",
    aggregateType: "PROJECT_MATERIAL_REQUIREMENT",
    aggregateId: input.event.requirementId,
    idempotencyKey: `${input.event.id}:${input.action}`,
    payload: { ...value, action: input.action, auditId: audit.id }
  });
  return { auditId: audit.id, outboxEventId: outbox.id };
}

async function alreadyRecordedExternalEvent(
  client: Prisma.TransactionClient,
  source: ProcurementSource,
  externalEventKey: string | null,
  expected: { projectId: string; requirementId: string; requirementRevisionId: string }
) {
  if (source !== "ERP" || !externalEventKey) return null;
  const current = await client.procurementFulfillmentEvent.findUnique({
    where: { source_externalEventKey: { source, externalEventKey } }
  });
  if (!current) return null;
  if (
    current.projectId !== expected.projectId ||
    current.requirementId !== expected.requirementId ||
    current.requirementRevisionId !== expected.requirementRevisionId
  ) {
    throw new FulfillmentEventServiceError(
      "PROC_EXTERNAL_EVENT_KEY_CONFLICT",
      "外部履约事件键已绑定到其他项目或需求。",
      409
    );
  }
  return current;
}

export function requiredFulfillmentPermission(eventTypeValue: FulfillmentEventType) {
  return receiptEventTypes.has(eventTypeValue)
    ? "PROJECT_PROCUREMENT_RECEIPT_RECORD"
    : "PROJECT_PROCUREMENT_ACCEPTANCE_RECORD";
}

export async function readProcurementFulfillmentEventType(input: {
  projectId: string;
  eventId: string;
}) {
  return db.procurementFulfillmentEvent.findFirst({
    where: { id: input.eventId, projectId: input.projectId },
    select: { id: true, eventType: true }
  });
}

export async function appendProcurementFulfillmentEvent(
  input: AppendFulfillmentEventInput,
  transaction?: Prisma.TransactionClient
) {
  const projectId = text(input.projectId, "projectId");
  const requirementId = text(input.requirementId, "requirementId");
  const requirementRevisionId = text(input.requirementRevisionId, "requirementRevisionId");
  const trackingLineId = optionalText(input.trackingLineId, "trackingLineId");
  const fulfillmentType = eventType(input.eventType);
  if (fulfillmentType === "REVERSED") {
    throw new FulfillmentEventServiceError(
      "PROC_EVENT_TYPE_INVALID",
      "冲销必须使用专用反向接口。",
      422
    );
  }
  const fulfillmentSource = source(input.source);
  const externalEventKey = optionalText(input.externalEventKey, "externalEventKey");
  if (fulfillmentSource === "ERP" && !externalEventKey) {
    throw new FulfillmentEventServiceError(
      "PROC_EXTERNAL_EVENT_KEY_REQUIRED",
      "ERP 履约事件必须提供稳定外部事件键。",
      422
    );
  }
  const externalDocumentRef = optionalText(input.externalDocumentRef, "externalDocumentRef");
  const evidenceFileId = optionalText(input.evidenceFileId, "evidenceFileId");
  const reason = text(input.reason, "reason", 1024);
  const businessOccurredAt = occurredAt(input.businessOccurredAt);

  return inTransaction(transaction, async (client) => {
    const context = await assertWritableContext(client, projectId);
    const requirement = await lockRequirement(client, projectId, requirementId);
    const revision = assertCurrentConfirmedRevision(requirement, requirementRevisionId);
    const replayedEvent = await alreadyRecordedExternalEvent(
      client,
      fulfillmentSource,
      externalEventKey,
      {
        projectId,
        requirementId,
        requirementRevisionId
      }
    );
    if (replayedEvent) {
      return {
        events: [replayedEvent],
        resourceVersion: requirement.version,
        auditIds: [],
        outboxEventIds: [],
        replayed: true
      };
    }
    await Promise.all([
      assertTrackingLine(
        client,
        { projectId, requirementId, requirementRevisionId, trackingLineId },
        revision.businessType
      ),
      assertEvidenceFile(client, projectId, evidenceFileId)
    ]);
    const totals = await loadEffectiveEventTotals(
      client,
      projectId,
      requirementId,
      requirementRevisionId
    );
    const validated = validateFulfillmentEvent({
      businessType: revision.businessType,
      eventType: fulfillmentType,
      quantity: input.quantity,
      trackingUnit: input.trackingUnit,
      requirementTrackingUnit: revision.trackingUnit,
      requiredQuantity: revision.quantity.toString(),
      ...totals
    });
    const recordedAt = await databaseNow(client);
    const event = await client.procurementFulfillmentEvent.create({
      data: {
        projectId,
        requirementId,
        requirementRevisionId,
        trackingLineId,
        eventType: validated.eventType,
        quantity: new Prisma.Decimal(validated.quantity),
        trackingUnit: validated.trackingUnit,
        businessOccurredAt,
        recordedAt,
        source: fulfillmentSource,
        externalEventKey,
        externalDocumentRef,
        evidenceFileId,
        reason,
        createdById: input.actorId
      }
    });

    const policy = input.readinessPolicy ?? {
      // No policy version exists until APM-091B. Preserve the conservative acceptance default.
      arrivalAutoUsable: false,
      inspectionRequired: true
    };
    const derived = deriveAutoUsableEvent({
      ...policy,
      event: {
        businessType: revision.businessType,
        eventType: fulfillmentType,
        quantity: validated.quantity,
        trackingUnit: validated.trackingUnit,
        requirementTrackingUnit: revision.trackingUnit,
        requiredQuantity: revision.quantity.toString(),
        ...totals,
        automaticArrivalUsable: true,
        source: "LOCAL",
        reason: "系统按到货自动可用政策标记可用。"
      }
    });
    const derivedEvent = derived
      ? await client.procurementFulfillmentEvent.create({
          data: {
            projectId,
            requirementId,
            requirementRevisionId,
            trackingLineId,
            eventType: derived.eventType,
            quantity: new Prisma.Decimal(derived.quantity),
            trackingUnit: derived.trackingUnit,
            businessOccurredAt,
            recordedAt,
            source: derived.source,
            derivedFromEventId: event.id,
            reason: derived.reason,
            createdById: input.actorId
          }
        })
      : null;
    const updatedRequirement = await client.projectMaterialRequirement.update({
      where: { id: requirementId },
      data: { version: { increment: 1 }, updatedById: input.actorId },
      select: { version: true }
    });
    const changes = await Promise.all(
      [event, derivedEvent]
        .filter((item): item is typeof event => item !== null)
        .map((recordedEvent) =>
          recordEventChange(client, {
            action: "recorded",
            event: recordedEvent,
            resourceVersion: updatedRequirement.version,
            auditContext: input.auditContext,
            actorId: input.actorId,
            project: context.project
          })
        )
    );
    return {
      events: [event, ...(derivedEvent ? [derivedEvent] : [])],
      resourceVersion: updatedRequirement.version,
      auditIds: changes.map((change) => change.auditId),
      outboxEventIds: changes.map((change) => change.outboxEventId),
      replayed: false
    };
  });
}

export async function reverseProcurementFulfillmentEvent(
  input: ReverseFulfillmentEventInput,
  transaction?: Prisma.TransactionClient
) {
  const projectId = text(input.projectId, "projectId");
  const eventId = text(input.eventId, "eventId");
  const expectedVersion = version(input.version);
  const reason = text(input.reason, "reason", 1024);
  return inTransaction(transaction, async (client) => {
    const context = await assertWritableContext(client, projectId);
    await client.$queryRaw`
      SELECT "id" FROM "procurement_fulfillment_events"
      WHERE (
        "id" = ${eventId} OR "derived_from_event_id" = ${eventId}
      ) AND "project_id" = ${projectId}
      FOR UPDATE
    `;
    const original = await client.procurementFulfillmentEvent.findFirst({
      where: { id: eventId, projectId },
      include: {
        reversedBy: { select: { id: true } },
        derivedAutoUsableEvent: { include: { reversedBy: { select: { id: true } } } }
      }
    });
    if (!original) {
      throw new FulfillmentEventServiceError(
        "PROC_FULFILLMENT_EVENT_NOT_FOUND",
        "履约事件不存在或不属于当前项目。",
        404
      );
    }
    if (original.eventType === "REVERSED" || original.reversedBy) {
      throw new FulfillmentEventServiceError(
        "PROC_EVENT_ALREADY_REVERSED",
        "该履约事件已经被反向处理。",
        409
      );
    }
    const requirement = await lockRequirement(client, projectId, original.requirementId);
    assertCurrentConfirmedRevision(requirement, original.requirementRevisionId);
    if (requirement.version !== expectedVersion) {
      throw new FulfillmentEventServiceError(
        "VERSION_CONFLICT",
        "履约事件聚合已发生变化，请刷新后重试。",
        409
      );
    }
    const reversalTargetIds = new Set(
      selectFulfillmentReversalEventIds({
        eventId: original.id,
        derivedAutoUsableEvent: original.derivedAutoUsableEvent
          ? {
              id: original.derivedAutoUsableEvent.id,
              hasReversal: original.derivedAutoUsableEvent.reversedBy !== null
            }
          : null
      })
    );
    const reversalTargets = [
      original,
      ...(original.derivedAutoUsableEvent ? [original.derivedAutoUsableEvent] : [])
    ].filter((event) => reversalTargetIds.has(event.id));
    const reversalOccurredAt = await databaseNow(client);
    const reversals = await Promise.all(
      reversalTargets.map((target) =>
        client.procurementFulfillmentEvent.create({
          data: {
            projectId,
            requirementId: target.requirementId,
            requirementRevisionId: target.requirementRevisionId,
            trackingLineId: target.trackingLineId,
            eventType: "REVERSED",
            quantity: target.quantity,
            trackingUnit: target.trackingUnit,
            businessOccurredAt: reversalOccurredAt,
            source: "LOCAL",
            reversesEventId: target.id,
            reason,
            createdById: input.actorId
          }
        })
      )
    );
    const updatedRequirement = await client.projectMaterialRequirement.update({
      where: { id: original.requirementId },
      data: { version: { increment: 1 }, updatedById: input.actorId },
      select: { version: true }
    });
    const changes = await Promise.all(
      reversals.map((reversal) =>
        recordEventChange(client, {
          action: "reversed",
          event: reversal,
          resourceVersion: updatedRequirement.version,
          auditContext: input.auditContext,
          actorId: input.actorId,
          project: context.project
        })
      )
    );
    return {
      events: reversals,
      resourceVersion: updatedRequirement.version,
      auditIds: changes.map((change) => change.auditId),
      outboxEventIds: changes.map((change) => change.outboxEventId),
      replayed: false
    };
  });
}

export async function listProcurementFulfillmentEvents(
  input: FulfillmentEventQuery
): Promise<FulfillmentEventPage> {
  const limit = Math.min(Math.max(input.limit, 1), 100);
  const rows = await db.procurementFulfillmentEvent.findMany({
    where: {
      projectId: input.projectId,
      ...(input.requirementId ? { requirementId: input.requirementId } : {})
    },
    orderBy: [{ businessOccurredAt: "desc" }, { id: "desc" }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: limit + 1
  });
  const events = rows.slice(0, limit);
  return { events, nextCursor: rows.length > limit ? (events.at(-1)?.id ?? null) : null };
}

export function isFulfillmentEventError(
  error: unknown
): error is FulfillmentEventError | FulfillmentEventServiceError {
  return error instanceof FulfillmentEventError || error instanceof FulfillmentEventServiceError;
}
