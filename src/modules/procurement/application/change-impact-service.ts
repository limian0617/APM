import { Prisma, type ProcurementMode } from "@prisma/client";

import { inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  PROCUREMENT_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import {
  detectProcurementChangeImpact,
  type DetectedProcurementChangeImpact,
  type ProcurementChangeImpactDisposition,
  type ProcurementChangeImpactObligationType,
  type ProcurementRevisionForChangeImpact
} from "@/modules/procurement/domain/change-impact";

import { appendReadinessRecalculationRequest } from "./readiness-service";

export class ProcurementChangeImpactServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "ProcurementChangeImpactServiceError";
  }
}

const DISPOSITIONS_BY_OBLIGATION: Readonly<
  Record<ProcurementChangeImpactObligationType, readonly ProcurementChangeImpactDisposition[]>
> = {
  PROCUREMENT_OWNER: ["OWNER_PLAN_CONFIRMED"],
  SUPPLIER: ["SUPPLIER_ACCEPTED"],
  ERP_PROJECTION: ["ERP_PROJECTED"],
  OLD_TRACKING: ["CANCELED", "REWORK", "RETURNED", "CONTINUE_USE"],
  OLD_FULFILLMENT: ["CANCELED", "REWORK", "RETURNED", "CONTINUE_USE"]
};

function requiredText(value: unknown, field: string, maximum = 1024): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maximum) {
    throw new ProcurementChangeImpactServiceError(
      "PROC_CHANGE_EVIDENCE_REQUIRED",
      `${field} 必须是 1 到 ${maximum} 个字符。`
    );
  }
  return value.trim();
}

function isDisposition(value: unknown): value is ProcurementChangeImpactDisposition {
  return (
    value === "OWNER_PLAN_CONFIRMED" ||
    value === "SUPPLIER_ACCEPTED" ||
    value === "ERP_PROJECTED" ||
    value === "CANCELED" ||
    value === "REWORK" ||
    value === "RETURNED" ||
    value === "CONTINUE_USE"
  );
}

export function validateChangeImpactResolution(input: {
  obligationType: ProcurementChangeImpactObligationType;
  disposition: unknown;
  evidenceReference: unknown;
  reason: unknown;
  erpProjection?: { confirmed: boolean; sourceVersion: string | null };
}) {
  if (!isDisposition(input.disposition)) {
    throw new ProcurementChangeImpactServiceError(
      "PROC_CHANGE_DISPOSITION_INVALID",
      "采购变更处置类型无效。"
    );
  }
  if (!DISPOSITIONS_BY_OBLIGATION[input.obligationType].includes(input.disposition)) {
    throw new ProcurementChangeImpactServiceError(
      "PROC_CHANGE_DISPOSITION_INVALID",
      "采购变更处置类型与待办义务不匹配。"
    );
  }
  const evidenceReference = requiredText(input.evidenceReference, "evidenceReference");
  const reason = requiredText(input.reason, "reason");
  if (
    input.obligationType === "ERP_PROJECTION" &&
    (!input.erpProjection?.confirmed || !input.erpProjection.sourceVersion?.trim())
  ) {
    throw new ProcurementChangeImpactServiceError(
      "PROC_CHANGE_ERP_PROJECTION_REQUIRED",
      "ERP 变更结果必须由带来源版本的只读投影确认。"
    );
  }
  return { disposition: input.disposition, evidenceReference, reason };
}

export function isChangeImpactResolved(
  obligations: readonly Readonly<{ resolved: boolean }>[]
): boolean {
  return obligations.length > 0 && obligations.every((obligation) => obligation.resolved);
}

export function assertImpactResolutionAllowed(input: {
  currentStatus: "OPEN" | "RESOLVED";
  requestedStatus: unknown;
  allObligationsResolved: boolean;
}) {
  if (input.currentStatus !== "OPEN" || input.requestedStatus !== "RESOLVED") {
    throw new ProcurementChangeImpactServiceError(
      "PROC_CHANGE_STATUS_TRANSITION_INVALID",
      "采购变更影响只能从 OPEN 进入 RESOLVED。"
    );
  }
  if (!input.allObligationsResolved) {
    throw new ProcurementChangeImpactServiceError(
      "PROC_CHANGE_OBLIGATIONS_INCOMPLETE",
      "所有采购变更影响义务均完成追加式处置证据后才能解决。"
    );
  }
}

function revisionFact(revision: {
  id: string;
  requirementId: string;
  materialReferenceId: string;
  quantity: Prisma.Decimal;
  trackingUnit: string;
  businessType: string;
  deliveryUnitId: string | null;
  moduleId: string | null;
  responsibilityPackageId: string | null;
  taskId: string | null;
  requiredOn: Date;
  predictedAssemblyStartOn: Date | null;
  drawingId: string | null;
  drawingVersionId: string | null;
  outsourcedProcess: string | null;
}): ProcurementRevisionForChangeImpact {
  return {
    id: revision.id,
    requirementId: revision.requirementId,
    materialReferenceId: revision.materialReferenceId,
    quantity: revision.quantity.toString(),
    trackingUnit: revision.trackingUnit,
    businessType: revision.businessType,
    deliveryUnitId: revision.deliveryUnitId,
    moduleId: revision.moduleId,
    responsibilityPackageId: revision.responsibilityPackageId,
    taskId: revision.taskId,
    requiredOn: revision.requiredOn.toISOString().slice(0, 10),
    predictedAssemblyStartOn: revision.predictedAssemblyStartOn?.toISOString().slice(0, 10) ?? null,
    drawingId: revision.drawingId,
    drawingVersionId: revision.drawingVersionId,
    outsourcedProcess: revision.outsourcedProcess
  };
}

function impactAuditValue(input: {
  impactId: string;
  projectId: string;
  previousRevisionId: string;
  nextRevisionId: string | null;
  changedFields: readonly string[];
  version?: number;
  obligationId?: string;
  disposition?: ProcurementChangeImpactDisposition;
  evidenceReference?: string;
  reason: string;
}) {
  return {
    projectId: input.projectId,
    procurementChangeImpactId: input.impactId,
    previousRevisionId: input.previousRevisionId,
    nextRevisionId: input.nextRevisionId,
    changedFields: [...input.changedFields],
    ...(input.obligationId ? { obligationId: input.obligationId } : {}),
    ...(input.disposition ? { disposition: input.disposition } : {}),
    ...(input.evidenceReference ? { evidenceReference: input.evidenceReference } : {}),
    ...(input.version === undefined ? {} : { version: input.version }),
    reason: input.reason
  };
}

export async function detectAndRecordProcurementChangeImpact(
  client: Prisma.TransactionClient,
  input: {
    projectId: string;
    requirementId: string;
    previousRevision: Parameters<typeof revisionFact>[0];
    nextRevision: Parameters<typeof revisionFact>[0] | null;
    previousStatus: string;
    mode: ProcurementMode;
    actorId: string;
    auditContext: AuditContext;
    reason: string;
  }
): Promise<{
  impact: Awaited<ReturnType<typeof client.procurementChangeImpact.create>>;
  detected: DetectedProcurementChangeImpact;
  auditId: string;
  outboxEventId: string;
} | null> {
  const [trackingLines, fulfillmentEvents, existing] = await Promise.all([
    client.procurementTrackingLine.findMany({
      where: { projectId: input.projectId, requirementRevisionId: input.previousRevision.id },
      select: {
        id: true,
        supplierReferenceId: true,
        responsibleMembershipId: true,
        source: true
      }
    }),
    client.procurementFulfillmentEvent.findMany({
      where: { projectId: input.projectId, requirementRevisionId: input.previousRevision.id },
      select: { id: true, source: true }
    }),
    client.procurementChangeImpact.findUnique({
      where: {
        projectId_previousRevisionId: {
          projectId: input.projectId,
          previousRevisionId: input.previousRevision.id
        }
      }
    })
  ]);
  if (existing) return null;
  const detected = detectProcurementChangeImpact({
    previous: revisionFact(input.previousRevision),
    next: input.nextRevision ? revisionFact(input.nextRevision) : null,
    previousStatus: input.previousStatus,
    previousTrackingLines: trackingLines,
    previousFulfillmentEvents: fulfillmentEvents,
    mode: input.mode
  });
  if (!detected) return null;
  const impact = await client.procurementChangeImpact.create({
    data: {
      projectId: input.projectId,
      requirementId: input.requirementId,
      previousRevisionId: detected.previousRevisionId,
      nextRevisionId: detected.nextRevisionId,
      type: detected.type,
      changedFieldsJson: detected.changedFields as Prisma.InputJsonValue,
      detectedById: input.actorId,
      obligations: {
        create: detected.obligations.map((obligation) => ({
          projectId: input.projectId,
          type: obligation.type,
          subjectId: obligation.subjectId
        }))
      }
    }
  });
  const audit = await writeAudit(client, {
    action: AUDIT_ACTIONS.PROCUREMENT_CHANGE_IMPACT_DETECTED,
    objectType: AUDIT_OBJECT_TYPES.PROCUREMENT_CHANGE_IMPACT,
    objectId: impact.id,
    context: {
      ...input.auditContext,
      projectId: input.projectId,
      actorId: input.actorId,
      reason: input.reason
    },
    after: {
      value: impactAuditValue({
        impactId: impact.id,
        projectId: input.projectId,
        previousRevisionId: impact.previousRevisionId,
        nextRevisionId: impact.nextRevisionId,
        changedFields: detected.changedFields,
        version: impact.version,
        reason: input.reason
      }),
      allowedFields: PROCUREMENT_AUDIT_FIELDS
    }
  });
  const outbox = await appendOutboxEvent(client, {
    eventType: "procurement.change-impact.detected",
    aggregateType: "PROCUREMENT_CHANGE_IMPACT",
    aggregateId: impact.id,
    idempotencyKey: impact.id,
    payload: {
      projectId: input.projectId,
      procurementChangeImpactId: impact.id,
      previousRevisionId: impact.previousRevisionId,
      nextRevisionId: impact.nextRevisionId,
      changedFields: detected.changedFields,
      auditId: audit.id
    },
    traceId: input.auditContext.traceId
  });
  await appendReadinessRecalculationRequest(client, {
    projectId: input.projectId,
    cause: "procurement-change-impact-detected",
    idempotencyKey: impact.id,
    traceId: input.auditContext.traceId
  });
  return { impact, detected, auditId: audit.id, outboxEventId: outbox.id };
}

export async function resolveProcurementChangeImpact(
  input: {
    projectId: string;
    impactId: string;
    obligationId: string;
    disposition: unknown;
    evidenceReference: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  return inTransaction(transaction, async (client) => {
    const impact = await client.procurementChangeImpact.findFirst({
      where: { id: input.impactId, projectId: input.projectId },
      include: { obligations: { include: { resolution: true } } }
    });
    if (!impact) {
      throw new ProcurementChangeImpactServiceError(
        "PROC_CHANGE_IMPACT_NOT_FOUND",
        "采购变更影响不存在或不属于当前项目。",
        404
      );
    }
    if (impact.status !== "OPEN") {
      throw new ProcurementChangeImpactServiceError(
        "PROC_CHANGE_ALREADY_RESOLVED",
        "采购变更影响已经解决。",
        409
      );
    }
    const obligation = impact.obligations.find((candidate) => candidate.id === input.obligationId);
    if (!obligation) {
      throw new ProcurementChangeImpactServiceError(
        "PROC_CHANGE_OBLIGATION_NOT_FOUND",
        "采购变更影响待办义务不存在或不属于当前项目。",
        404
      );
    }
    const membership = await client.projectMember.findFirst({
      where: { projectId: input.projectId, userId: input.actorId, leftAt: null },
      select: { id: true, projectRole: true }
    });
    if (!membership) {
      throw new ProcurementChangeImpactServiceError(
        "PROC_CHANGE_ACTOR_NOT_PROJECT_MEMBER",
        "只有当前项目有效成员可以处置采购变更影响。",
        403
      );
    }
    if (
      obligation.type === "PROCUREMENT_OWNER" &&
      (obligation.subjectId === "unassigned" || obligation.subjectId !== membership.id)
    ) {
      throw new ProcurementChangeImpactServiceError(
        "PROC_CHANGE_OWNER_REQUIRED",
        "采购负责人必须由跟踪行指定的项目成员确认处置。",
        403
      );
    }
    const erpProjection =
      obligation.type === "ERP_PROJECTION"
        ? await readErpProjectionFact(client, input.projectId, impact.previousRevisionId)
        : undefined;
    const validated = validateChangeImpactResolution({
      obligationType: obligation.type,
      disposition: input.disposition,
      evidenceReference: input.evidenceReference,
      reason: input.reason,
      erpProjection
    });
    if (obligation.resolution) {
      return { resolution: obligation.resolution, idempotent: true, impact };
    }
    const resolution = await client.procurementChangeImpactResolution.create({
      data: {
        projectId: input.projectId,
        impactId: impact.id,
        obligationId: obligation.id,
        disposition: validated.disposition,
        evidenceReference: validated.evidenceReference,
        reason: validated.reason,
        confirmedById: input.actorId
      }
    });
    const evidenceAudit = await writeAudit(client, {
      action: AUDIT_ACTIONS.PROCUREMENT_CHANGE_IMPACT_EVIDENCE_RECORDED,
      objectType: AUDIT_OBJECT_TYPES.PROCUREMENT_CHANGE_IMPACT_RESOLUTION,
      objectId: resolution.id,
      context: {
        ...input.auditContext,
        projectId: input.projectId,
        actorId: input.actorId,
        reason: validated.reason
      },
      after: {
        value: impactAuditValue({
          impactId: impact.id,
          projectId: input.projectId,
          previousRevisionId: impact.previousRevisionId,
          nextRevisionId: impact.nextRevisionId,
          changedFields: Array.isArray(impact.changedFieldsJson)
            ? impact.changedFieldsJson.filter((value): value is string => typeof value === "string")
            : [],
          obligationId: obligation.id,
          disposition: validated.disposition,
          evidenceReference: validated.evidenceReference,
          reason: validated.reason
        }),
        allowedFields: PROCUREMENT_AUDIT_FIELDS
      }
    });
    const resolved = isChangeImpactResolved(
      impact.obligations.map((candidate) => ({
        resolved: candidate.id === obligation.id || candidate.resolution !== null
      }))
    );
    let resolvedImpact = impact;
    let resolvedAuditId: string | null = null;
    let resolvedOutboxId: string | null = null;
    if (resolved) {
      assertImpactResolutionAllowed({
        currentStatus: impact.status,
        requestedStatus: "RESOLVED",
        allObligationsResolved: true
      });
      const resolvedAt = await databaseNow(client);
      resolvedImpact = await client.procurementChangeImpact.update({
        where: { id: impact.id },
        data: {
          status: "RESOLVED",
          version: { increment: 1 },
          resolvedById: input.actorId,
          resolvedAt
        },
        include: { obligations: { include: { resolution: true } } }
      });
      const resolvedAudit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PROCUREMENT_CHANGE_IMPACT_RESOLVED,
        objectType: AUDIT_OBJECT_TYPES.PROCUREMENT_CHANGE_IMPACT,
        objectId: impact.id,
        context: {
          ...input.auditContext,
          projectId: input.projectId,
          actorId: input.actorId,
          reason: validated.reason
        },
        after: {
          value: impactAuditValue({
            impactId: impact.id,
            projectId: input.projectId,
            previousRevisionId: impact.previousRevisionId,
            nextRevisionId: impact.nextRevisionId,
            changedFields: Array.isArray(impact.changedFieldsJson)
              ? impact.changedFieldsJson.filter(
                  (value): value is string => typeof value === "string"
                )
              : [],
            version: resolvedImpact.version,
            reason: validated.reason
          }),
          allowedFields: PROCUREMENT_AUDIT_FIELDS
        }
      });
      resolvedAuditId = resolvedAudit.id;
      const resolvedOutbox = await appendOutboxEvent(client, {
        eventType: "procurement.change-impact.resolved",
        aggregateType: "PROCUREMENT_CHANGE_IMPACT",
        aggregateId: impact.id,
        idempotencyKey: `${impact.id}:resolved:v${resolvedImpact.version}`,
        payload: {
          projectId: input.projectId,
          procurementChangeImpactId: impact.id,
          auditId: resolvedAudit.id
        },
        traceId: input.auditContext.traceId
      });
      resolvedOutboxId = resolvedOutbox.id;
    }
    const evidenceOutbox = await appendOutboxEvent(client, {
      eventType: "procurement.change-impact.evidence-recorded",
      aggregateType: "PROCUREMENT_CHANGE_IMPACT",
      aggregateId: impact.id,
      idempotencyKey: resolution.id,
      payload: {
        projectId: input.projectId,
        procurementChangeImpactId: impact.id,
        obligationId: obligation.id,
        disposition: validated.disposition,
        auditId: evidenceAudit.id
      },
      traceId: input.auditContext.traceId
    });
    await appendReadinessRecalculationRequest(client, {
      projectId: input.projectId,
      cause: resolved
        ? "procurement-change-impact-resolved"
        : "procurement-change-impact-evidence-recorded",
      idempotencyKey: resolution.id,
      traceId: input.auditContext.traceId
    });
    return {
      resolution,
      impact: resolvedImpact,
      idempotent: false,
      auditId: evidenceAudit.id,
      outboxEventId: evidenceOutbox.id,
      resolvedAuditId,
      resolvedOutboxId
    };
  });
}

async function readErpProjectionFact(
  client: Prisma.TransactionClient,
  projectId: string,
  previousRevisionId: string
) {
  const [tracking, event] = await Promise.all([
    client.procurementTrackingLine.findFirst({
      where: {
        projectId,
        requirementRevisionId: previousRevisionId,
        source: "ERP",
        sourceVersion: { not: null }
      },
      select: { sourceVersion: true }
    }),
    client.procurementFulfillmentEvent.findFirst({
      where: {
        projectId,
        requirementRevisionId: previousRevisionId,
        source: "ERP",
        externalEventKey: { not: null }
      },
      select: { externalEventKey: true }
    })
  ]);
  return {
    confirmed: tracking?.sourceVersion !== null || event?.externalEventKey !== null,
    sourceVersion: tracking?.sourceVersion ?? event?.externalEventKey ?? null
  };
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}
