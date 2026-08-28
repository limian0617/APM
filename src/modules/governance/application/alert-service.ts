import { Prisma, ProjectAlertEventType, ProjectAlertStatus } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import {
  readAssetImpactAlertSource,
  type AssetImpactAlertSource
} from "@/modules/assets/application/project-asset-impact-alert-source";
import { buildAssetImpactProjectionAttemptKey } from "@/modules/assets/domain/asset-upgrade-impact";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import { sanitizeAuditText } from "@/modules/audit/domain/sanitize";
import {
  ALERT_AUDIT_FIELDS,
  ASSET_UPGRADE_IMPACT_AUDIT_FIELDS,
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_RESULTS,
  AUDIT_SOURCES
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";

import {
  buildProcurementChangeBlockedFacts,
  evaluateAlertCandidates,
  type ProcurementAlertFacts
} from "../domain/alert-evaluation";
import {
  AlertValidationError,
  ALERT_SOURCE_TYPES,
  nextAlertStatus,
  validateAlertRuleConfig,
  type AlertAction,
  type AlertRiskLevel,
  type AlertSourceType
} from "../domain/alert-policy";
import { appendOutboxEvent } from "../infrastructure/outbox";

export class AlertServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const activeStatuses: ProjectAlertStatus[] = ["TRIGGERED", "ACKNOWLEDGED", "IN_PROGRESS"];

function text(value: unknown, field: string, maximum = 191): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new AlertValidationError(`${field} 必须是 1 到 ${maximum} 个字符。`);
  }
  return value.trim();
}

function code(value: unknown): string {
  const normalized = text(value, "code", 101);
  if (!/^[A-Z][A-Z0-9_.-]{2,100}$/.test(normalized)) {
    throw new AlertValidationError("code 格式无效。 ");
  }
  return normalized;
}

function risk(value: unknown, field: string): AlertRiskLevel {
  if (value !== "LOW" && value !== "MEDIUM" && value !== "HIGH") {
    throw new AlertValidationError(`${field} 必须是 LOW、MEDIUM 或 HIGH。`);
  }
  return value;
}

function escalationDays(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 3650) {
    throw new AlertValidationError("escalationAfterDays 必须是 0 到 3650 的整数。 ");
  }
  return value as number;
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  if (!clock) throw new Error("无法读取数据库时间。 ");
  return clock.now;
}

async function activeMembership(
  client: Prisma.TransactionClient,
  projectId: string,
  membershipId: string,
  field: string
) {
  const membership = await client.projectMember.findFirst({
    where: { id: membershipId, projectId, leftAt: null, user: { status: "ACTIVE" } },
    select: {
      id: true,
      userId: true,
      projectId: true,
      projectRole: true,
      departmentId: true,
      joinedAt: true
    }
  });
  if (!membership)
    throw new AlertServiceError("MEMBERSHIP_INVALID", `${field} 必须是当前项目有效成员。`, 422);
  return membership;
}

async function appendEvent(
  client: Prisma.TransactionClient,
  input: {
    projectId: string;
    alertId: string;
    eventType: ProjectAlertEventType;
    reason: string;
    snapshot: Record<string, unknown>;
    actorId: string | null;
  }
) {
  await client.$queryRaw`SELECT "id" FROM "project_alerts" WHERE "id" = ${input.alertId} FOR UPDATE`;
  const sequence =
    (await client.projectAlertEvent.count({ where: { alertId: input.alertId } })) + 1;
  return client.projectAlertEvent.create({
    data: {
      projectId: input.projectId,
      alertId: input.alertId,
      sequence,
      eventType: input.eventType,
      reason: input.reason,
      snapshotJson: input.snapshot as Prisma.InputJsonValue,
      actorId: input.actorId
    }
  });
}

function workerAuditContext(
  projectId: string,
  actorId: string | null,
  reason: string
): AuditContext {
  return {
    actorId,
    requestId: null,
    traceId: null,
    source: AUDIT_SOURCES.WORKER,
    sourceIp: null,
    userAgent: null,
    reason,
    projectId,
    departmentId: null,
    operationId: null
  };
}

function alertAuditValue(alert: {
  id: string;
  projectId: string;
  ruleId: string;
  sourceType: string;
  sourceKey: string;
  status: string;
  probability: string;
  impact: string;
  ownerUserId: string;
  escalationUserId: string;
  version: number;
}) {
  return {
    projectId: alert.projectId,
    alertId: alert.id,
    alertRuleId: alert.ruleId,
    sourceType: alert.sourceType,
    sourceKey: alert.sourceKey,
    status: alert.status,
    probability: alert.probability,
    impact: alert.impact,
    ownerUserId: alert.ownerUserId,
    escalationUserId: alert.escalationUserId,
    version: alert.version
  };
}

function ruleAuditValue(rule: {
  id: string;
  projectId: string;
  code: string;
  sourceType: string;
  probability: string;
  impact: string;
  ownerMembershipId: string;
  escalationMembershipId: string;
  escalationAfterDays: number;
  status: string;
  version: number;
}) {
  return {
    projectId: rule.projectId,
    alertRuleId: rule.id,
    code: rule.code,
    sourceType: rule.sourceType,
    probability: rule.probability,
    impact: rule.impact,
    ownerMembershipId: rule.ownerMembershipId,
    escalationMembershipId: rule.escalationMembershipId,
    escalationAfterDays: rule.escalationAfterDays,
    status: rule.status,
    version: rule.version
  };
}

function mapAlertAuditAction(eventType: ProjectAlertEventType) {
  switch (eventType) {
    case "ACKNOWLEDGED":
      return AUDIT_ACTIONS.ALERT_ACKNOWLEDGED;
    case "STARTED":
      return AUDIT_ACTIONS.ALERT_STARTED;
    case "RESOLVED":
      return AUDIT_ACTIONS.ALERT_RESOLVED;
    case "CLOSED":
      return AUDIT_ACTIONS.ALERT_CLOSED;
    case "ESCALATED":
      return AUDIT_ACTIONS.ALERT_ESCALATED;
    case "TRIGGERED":
    case "RETRIGGERED":
      return AUDIT_ACTIONS.ALERT_TRIGGERED;
  }
}

async function writeAlertLifecycleAudit(
  client: Prisma.TransactionClient,
  input: {
    projectId: string;
    alert: Parameters<typeof alertAuditValue>[0];
    eventType: ProjectAlertEventType;
    reason: string;
    actorId: string | null;
    auditContext?: AuditContext;
    sourceSnapshot?: Record<string, unknown>;
  }
) {
  return writeAudit(client, {
    action: mapAlertAuditAction(input.eventType),
    objectType: AUDIT_OBJECT_TYPES.PROJECT_ALERT,
    objectId: input.alert.id,
    context: input.auditContext ?? workerAuditContext(input.projectId, input.actorId, input.reason),
    after: {
      value: {
        ...alertAuditValue(input.alert),
        ...input.sourceSnapshot,
        eventType: input.eventType,
        reason: input.reason
      },
      allowedFields: ALERT_AUDIT_FIELDS
    }
  });
}

export async function createProjectAlertRule(
  input: {
    projectId: unknown;
    code: unknown;
    name: unknown;
    sourceType: unknown;
    condition: unknown;
    probability: unknown;
    impact: unknown;
    ownerMembershipId: unknown;
    escalationMembershipId: unknown;
    escalationAfterDays: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = text(input.projectId, "projectId");
  const ruleCode = code(input.code);
  const name = text(input.name, "name");
  const sourceType = input.sourceType as AlertSourceType;
  const condition = validateAlertRuleConfig(sourceType, input.condition);
  const probability = risk(input.probability, "probability");
  const impact = risk(input.impact, "impact");
  const ownerMembershipId = text(input.ownerMembershipId, "ownerMembershipId");
  const escalationMembershipId = text(input.escalationMembershipId, "escalationMembershipId");
  const afterDays = escalationDays(input.escalationAfterDays);

  return inTransaction(transaction, async (client) => {
    const [owner, escalation] = await Promise.all([
      activeMembership(client, projectId, ownerMembershipId, "ownerMembershipId"),
      activeMembership(client, projectId, escalationMembershipId, "escalationMembershipId")
    ]);
    const rule = await client.projectAlertRule.create({
      data: {
        projectId,
        code: ruleCode,
        name,
        sourceType,
        conditionJson: condition as Prisma.InputJsonValue,
        probability,
        impact,
        ownerMembershipId: owner.id,
        escalationMembershipId: escalation.id,
        escalationAfterDays: afterDays,
        createdById: input.actorId,
        updatedById: input.actorId
      }
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.ALERT_RULE_CREATED,
      objectType: AUDIT_OBJECT_TYPES.ALERT_RULE,
      objectId: rule.id,
      context: { ...input.auditContext, actorId: input.actorId, projectId },
      after: {
        value: ruleAuditValue(rule),
        allowedFields: ALERT_AUDIT_FIELDS
      }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "governance.alert-rule.created",
      aggregateType: "ALERT_RULE",
      aggregateId: rule.id,
      idempotencyKey: rule.id,
      payload: { projectId, alertRuleId: rule.id, sourceType, auditId: audit.id }
    });
    return { rule, auditId: audit.id, outboxEventId: outbox.id };
  });
}

export async function updateProjectAlertRule(
  input: {
    projectId: unknown;
    ruleId: unknown;
    version: unknown;
    code: unknown;
    name: unknown;
    sourceType: unknown;
    condition: unknown;
    probability: unknown;
    impact: unknown;
    ownerMembershipId: unknown;
    escalationMembershipId: unknown;
    escalationAfterDays: unknown;
    status: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = text(input.projectId, "projectId");
  const ruleId = text(input.ruleId, "ruleId");
  const version = input.version;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new AlertValidationError("version 必须是正整数。");
  }
  const ruleCode = code(input.code);
  const name = text(input.name, "name");
  const sourceType = input.sourceType as AlertSourceType;
  const condition = validateAlertRuleConfig(sourceType, input.condition);
  const probability = risk(input.probability, "probability");
  const impact = risk(input.impact, "impact");
  const ownerMembershipId = text(input.ownerMembershipId, "ownerMembershipId");
  const escalationMembershipId = text(input.escalationMembershipId, "escalationMembershipId");
  const afterDays = escalationDays(input.escalationAfterDays);
  const status = input.status === "ENABLED" || input.status === "DISABLED" ? input.status : null;
  if (!status) throw new AlertValidationError("status 必须是 ENABLED 或 DISABLED。");
  const reason = text(input.reason, "reason", 1024);

  return inTransaction(transaction, async (client) => {
    await client.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "projects"
      WHERE "id" = ${projectId}
      FOR UPDATE
    `;
    await client.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "project_alert_rules"
      WHERE "id" = ${ruleId} AND "project_id" = ${projectId}
      FOR UPDATE
    `;
    const current = await client.projectAlertRule.findFirst({ where: { id: ruleId, projectId } });
    if (!current)
      throw new AlertServiceError("ALERT_RULE_NOT_FOUND", "预警规则不存在或不属于该项目。", 404);
    const [owner, escalation] = await Promise.all([
      activeMembership(client, projectId, ownerMembershipId, "ownerMembershipId"),
      activeMembership(client, projectId, escalationMembershipId, "escalationMembershipId")
    ]);
    const updatedCount = await client.projectAlertRule.updateMany({
      where: { id: current.id, projectId, version: version as number },
      data: {
        code: ruleCode,
        name,
        sourceType,
        conditionJson: condition as Prisma.InputJsonValue,
        probability,
        impact,
        ownerMembershipId: owner.id,
        escalationMembershipId: escalation.id,
        escalationAfterDays: afterDays,
        status,
        updatedById: input.actorId,
        version: { increment: 1 }
      }
    });
    if (updatedCount.count !== 1)
      throw new AlertServiceError("VERSION_CONFLICT", "预警规则已被其他操作更新。", 409);
    const rule = await client.projectAlertRule.findUniqueOrThrow({ where: { id: current.id } });
    if (current.status === "ENABLED" && rule.status === "DISABLED") {
      const now = await databaseNow(client);
      const activeAlerts = await client.projectAlert.findMany({
        where: { projectId, ruleId: rule.id, status: { in: activeStatuses } }
      });
      for (const alert of activeAlerts) {
        const resolved = await client.projectAlert.update({
          where: { id: alert.id },
          data: { status: "RESOLVED", resolvedAt: now, version: { increment: 1 } }
        });
        await appendEvent(client, {
          projectId,
          alertId: resolved.id,
          eventType: "RESOLVED",
          reason: "预警规则已停用。",
          snapshot: { alertRuleId: rule.id, ruleVersion: rule.version },
          actorId: input.actorId
        });
        await writeAlertLifecycleAudit(client, {
          projectId,
          alert: resolved,
          eventType: "RESOLVED",
          reason: "预警规则已停用。",
          actorId: input.actorId,
          auditContext: { ...input.auditContext, actorId: input.actorId, projectId, reason }
        });
        await appendOutboxEvent(client, {
          eventType: "governance.alert.resolved",
          aggregateType: "PROJECT_ALERT",
          aggregateId: resolved.id,
          idempotencyKey: `${resolved.id}:resolved:${resolved.version}`,
          payload: { projectId, alertId: resolved.id, reason: "RULE_DISABLED" }
        });
      }
    }
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.ALERT_RULE_UPDATED,
      objectType: AUDIT_OBJECT_TYPES.ALERT_RULE,
      objectId: rule.id,
      context: { ...input.auditContext, actorId: input.actorId, projectId, reason },
      before: { value: ruleAuditValue(current), allowedFields: ALERT_AUDIT_FIELDS },
      after: { value: ruleAuditValue(rule), allowedFields: ALERT_AUDIT_FIELDS }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "governance.alert-rule.updated",
      aggregateType: "ALERT_RULE",
      aggregateId: rule.id,
      idempotencyKey: `${rule.id}:version:${rule.version}`,
      payload: {
        projectId,
        alertRuleId: rule.id,
        version: rule.version,
        status: rule.status,
        auditId: audit.id
      }
    });
    return { rule, auditId: audit.id, outboxEventId: outbox.id };
  });
}

export async function requestProjectAlertScan(
  input: {
    projectId: unknown;
    idempotencyKey: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = text(input.projectId, "projectId");
  const idempotencyKey = text(input.idempotencyKey, "idempotencyKey");
  return inTransaction(transaction, async (client) => {
    const existing = await client.projectAlertScan.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } }
    });
    if (existing) return { scan: existing, repeated: true, auditId: null, outboxEventId: null };
    const scan = await client.projectAlertScan.create({
      data: { projectId, idempotencyKey, requestedById: input.actorId }
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.ALERT_SCAN_REQUESTED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_ALERT_SCAN,
      objectId: scan.id,
      context: { ...input.auditContext, actorId: input.actorId, projectId },
      after: { value: { projectId, scanId: scan.id }, allowedFields: ALERT_AUDIT_FIELDS }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "governance.alert-scan.requested",
      aggregateType: "PROJECT_ALERT_SCAN",
      aggregateId: scan.id,
      idempotencyKey: scan.id,
      payload: { projectId, scanId: scan.id }
    });
    return { scan, repeated: false, auditId: audit.id, outboxEventId: outbox.id };
  });
}

type AlertRuleForScan = Awaited<ReturnType<typeof db.projectAlertRule.findMany>>[number];

function hasPositiveQuantity(value: { toString(): string }): boolean {
  const normalized = value.toString().trim();
  return /^\d+(?:\.\d+)?$/u.test(normalized) && /[1-9]/u.test(normalized);
}

function ruleCondition(value: Prisma.JsonValue): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("预警规则条件无效。 ");
  return value as Record<string, unknown>;
}

export async function runProjectAlertScan(input: { projectId: string; scanId: string }) {
  try {
    return await db.$transaction(async (client) => {
      const scan = await client.projectAlertScan.findFirst({
        where: { id: input.scanId, projectId: input.projectId }
      });
      if (!scan)
        throw new AlertServiceError("SCAN_NOT_FOUND", "预警扫描不存在或不属于该项目。", 404);
      if (scan.status === "SUCCEEDED") return { scan, repeated: true, triggeredCount: 0 };
      const now = await databaseNow(client);
      await client.projectAlertScan.update({
        where: { id: scan.id },
        data: {
          status: "RUNNING",
          startedAt: scan.startedAt ?? now,
          completedAt: null,
          errorCode: null,
          errorMessage: null
        }
      });
      const [
        rules,
        scheduleState,
        milestones,
        gateInstances,
        residualItems,
        procurementRequirements,
        procurementChangeImpacts,
        readinessResults
      ] = await Promise.all([
        client.projectAlertRule.findMany({
          where: {
            projectId: input.projectId,
            status: "ENABLED",
            sourceType: { not: ALERT_SOURCE_TYPES.ASSET_IMPACT }
          }
        }),
        client.projectScheduleState.findUnique({
          where: { projectId: input.projectId },
          include: { latestPublishedRecalculation: true }
        }),
        client.projectMilestone.findMany({
          where: { projectId: input.projectId },
          select: { id: true, targetAt: true, status: true }
        }),
        client.projectGateInstance.findMany({
          where: { projectId: input.projectId },
          select: {
            checkSnapshots: {
              orderBy: { sequence: "desc" },
              take: 1,
              select: {
                results: { where: { status: "HARD_FAILED" }, select: { id: true, message: true } }
              }
            }
          }
        }),
        client.residualItem.findMany({
          where: { projectId: input.projectId },
          select: { id: true, dueAt: true, status: true }
        }),
        client.projectMaterialRequirement.findMany({
          where: { projectId: input.projectId },
          select: {
            id: true,
            status: true,
            currentRevision: {
              select: {
                id: true,
                requiredOn: true,
                predictedAssemblyStartOn: true,
                isCritical: true,
                status: true
              }
            },
            revisions: {
              select: { id: true, status: true }
            },
            procurementTrackingLines: {
              select: {
                requirementRevisionId: true,
                orderedQuantity: true,
                promisedOn: true
              }
            }
          }
        }),
        client.procurementChangeImpact.findMany({
          where: { projectId: input.projectId, status: "OPEN" },
          select: { id: true, requirementId: true, status: true, type: true }
        }),
        client.procurementReadinessResult.findMany({
          where: { projectId: input.projectId },
          orderBy: [{ calculatedAt: "desc" }, { id: "desc" }],
          select: {
            scopeType: true,
            scopeId: true,
            inputWatermark: true,
            formulaVersion: true,
            status: true,
            pendingAcceptanceLines: true,
            blockingCriticalLines: true,
            sourceSyncedAt: true,
            calculatedAt: true
          }
        })
      ]);
      const gateFailures = gateInstances.flatMap((instance) =>
        instance.checkSnapshots.flatMap((snapshot) => snapshot.results)
      );
      const forecasts = scheduleState?.latestPublishedRecalculationId
        ? await client.scheduleTaskForecast.findMany({
            where: {
              projectId: input.projectId,
              recalculationId: scheduleState.latestPublishedRecalculationId,
              isCritical: true
            },
            include: { task: { select: { plannedFinishAt: true } } }
          })
        : [];
      const latestReadinessRoot = readinessResults.find(
        (result) => result.scopeType === "PROJECT" && result.scopeId === input.projectId
      );
      const currentReadinessResults = latestReadinessRoot
        ? readinessResults.filter(
            (result) =>
              result.inputWatermark === latestReadinessRoot.inputWatermark &&
              result.formulaVersion === latestReadinessRoot.formulaVersion
          )
        : [];
      const readinessByRequirement = new Map(
        currentReadinessResults
          .filter((result) => result.scopeType === "REQUIREMENT")
          .map((result) => [result.scopeId, result])
      );
      const procurementFacts: ProcurementAlertFacts = {
        notOrdered: procurementRequirements.flatMap((requirement) => {
          const revision = requirement.currentRevision;
          if (requirement.status !== "CONFIRMED" || !revision) return [];
          const ordered = requirement.procurementTrackingLines.some(
            (line) =>
              line.requirementRevisionId === revision.id &&
              hasPositiveQuantity(line.orderedQuantity)
          );
          return ordered
            ? []
            : [{ requirementId: requirement.id, isCritical: revision.isCritical }];
        }),
        late: procurementRequirements.flatMap((requirement) => {
          const revision = requirement.currentRevision;
          if (requirement.status !== "CONFIRMED" || !revision) return [];
          const deadlines = [revision.requiredOn, revision.predictedAssemblyStartOn]
            .filter((value): value is Date => value !== null)
            .sort((left, right) => left.getTime() - right.getTime());
          const deadline = deadlines[0];
          if (!deadline) return [];
          const lateLine = requirement.procurementTrackingLines
            .filter(
              (line) =>
                line.requirementRevisionId === revision.id &&
                line.promisedOn !== null &&
                line.promisedOn.getTime() > deadline.getTime()
            )
            .sort((left, right) => left.promisedOn!.getTime() - right.promisedOn!.getTime())[0];
          return lateLine?.promisedOn
            ? [
                {
                  requirementId: requirement.id,
                  promisedOn: lateLine.promisedOn.toISOString(),
                  requiredOn: deadline.toISOString()
                }
              ]
            : [];
        }),
        pendingAcceptance: procurementRequirements.flatMap((requirement) => {
          const revision = requirement.currentRevision;
          const readiness = readinessByRequirement.get(requirement.id);
          if (
            requirement.status !== "CONFIRMED" ||
            !revision ||
            !readiness ||
            readiness.pendingAcceptanceLines <= 0 ||
            !revision.predictedAssemblyStartOn ||
            revision.predictedAssemblyStartOn.getTime() > now.getTime()
          ) {
            return [];
          }
          return [
            {
              requirementId: requirement.id,
              arrivedQuantity: null,
              usableQuantity: null,
              assemblyWindowAt: revision.predictedAssemblyStartOn.toISOString()
            }
          ];
        }),
        criticalShortage: currentReadinessResults.flatMap((result) =>
          result.scopeType === "REQUIREMENT" && result.blockingCriticalLines > 0
            ? [{ requirementId: result.scopeId, criticalGapLines: result.blockingCriticalLines }]
            : []
        ),
        changeBlocked: buildProcurementChangeBlockedFacts(procurementChangeImpacts),
        dataStale:
          latestReadinessRoot?.status === "STALE"
            ? {
                sourceId: "project",
                inputWatermark: latestReadinessRoot.inputWatermark,
                calculatedAt: latestReadinessRoot.calculatedAt.toISOString()
              }
            : null
      };
      let triggeredCount = 0;
      for (const rule of rules as AlertRuleForScan[]) {
        const candidates = evaluateAlertCandidates(
          { sourceType: rule.sourceType, condition: ruleCondition(rule.conditionJson) },
          now,
          {
            scheduleCalculatedAt: scheduleState?.latestPublishedRecalculation?.completedAt ?? null,
            criticalTasks: forecasts.map((forecast) => ({
              id: forecast.taskId,
              plannedFinishAt: forecast.task.plannedFinishAt,
              predictedFinishAt: forecast.predictedFinishAt,
              isCritical: true
            })),
            milestones,
            gateFailures,
            residualItems,
            procurementFacts
          }
        );
        const [owner, escalation] = await Promise.all([
          activeMembership(client, input.projectId, rule.ownerMembershipId, "规则Owner"),
          activeMembership(client, input.projectId, rule.escalationMembershipId, "规则升级人")
        ]);
        const keys = new Set(candidates.map((candidate) => candidate.sourceKey));
        for (const candidate of candidates) {
          const existing = await client.projectAlert.findUnique({
            where: {
              projectId_ruleId_sourceKey: {
                projectId: input.projectId,
                ruleId: rule.id,
                sourceKey: candidate.sourceKey
              }
            }
          });
          if (!existing) {
            const alert = await client.projectAlert.create({
              data: {
                projectId: input.projectId,
                ruleId: rule.id,
                sourceType: rule.sourceType,
                sourceKey: candidate.sourceKey,
                sourceSnapshot: candidate.snapshot as Prisma.InputJsonValue,
                probability: rule.probability,
                impact: rule.impact,
                ownerUserId: owner.userId,
                ownerMembershipSnapshot: owner as Prisma.InputJsonValue,
                escalationUserId: escalation.userId,
                escalationMembershipSnapshot: escalation as Prisma.InputJsonValue,
                firstTriggeredAt: now,
                lastObservedAt: now
              }
            });
            await appendEvent(client, {
              projectId: input.projectId,
              alertId: alert.id,
              eventType: "TRIGGERED",
              reason: "预警扫描触发。",
              snapshot: candidate.snapshot,
              actorId: null
            });
            await writeAlertLifecycleAudit(client, {
              projectId: input.projectId,
              alert,
              eventType: "TRIGGERED",
              reason: "预警扫描触发。",
              actorId: null
            });
            await appendOutboxEvent(client, {
              eventType: "governance.alert.triggered",
              aggregateType: "PROJECT_ALERT",
              aggregateId: alert.id,
              idempotencyKey: `${alert.id}:triggered`,
              payload: { projectId: input.projectId, alertId: alert.id, ownerUserId: owner.userId }
            });
            triggeredCount++;
          } else if (existing.status === "RESOLVED") {
            const alert = await client.projectAlert.update({
              where: { id: existing.id },
              data: {
                status: "TRIGGERED",
                resolvedAt: null,
                closedAt: null,
                lastObservedAt: now,
                sourceSnapshot: candidate.snapshot as Prisma.InputJsonValue,
                version: { increment: 1 }
              }
            });
            await appendEvent(client, {
              projectId: input.projectId,
              alertId: alert.id,
              eventType: "RETRIGGERED",
              reason: "预警源再次满足触发条件。",
              snapshot: candidate.snapshot,
              actorId: null
            });
            await writeAlertLifecycleAudit(client, {
              projectId: input.projectId,
              alert,
              eventType: "RETRIGGERED",
              reason: "预警源再次满足触发条件。",
              actorId: null
            });
            await appendOutboxEvent(client, {
              eventType: "governance.alert.triggered",
              aggregateType: "PROJECT_ALERT",
              aggregateId: alert.id,
              idempotencyKey: `${alert.id}:retriggered:${alert.version}`,
              payload: {
                projectId: input.projectId,
                alertId: alert.id,
                ownerUserId: alert.ownerUserId
              }
            });
            triggeredCount++;
          } else if (existing.status !== "CLOSED") {
            await client.projectAlert.update({
              where: { id: existing.id },
              data: {
                lastObservedAt: now,
                sourceSnapshot: candidate.snapshot as Prisma.InputJsonValue
              }
            });
          } else {
            const recurred =
              existing.closedAt !== null && existing.lastObservedAt <= existing.closedAt;
            const observed = await client.projectAlert.update({
              where: { id: existing.id },
              data: {
                lastObservedAt: now,
                sourceSnapshot: candidate.snapshot as Prisma.InputJsonValue,
                ...(recurred ? { version: { increment: 1 } } : {})
              }
            });
            if (recurred) {
              await appendEvent(client, {
                projectId: input.projectId,
                alertId: existing.id,
                eventType: "RETRIGGERED",
                reason: "已关闭预警的来源再次满足触发条件，保留关闭事实并追加复发事件。",
                snapshot: candidate.snapshot,
                actorId: null
              });
              await writeAlertLifecycleAudit(client, {
                projectId: input.projectId,
                alert: observed,
                eventType: "RETRIGGERED",
                reason: "已关闭预警来源复发。",
                actorId: null
              });
              await appendOutboxEvent(client, {
                eventType: "governance.alert.recurred",
                aggregateType: "PROJECT_ALERT",
                aggregateId: existing.id,
                idempotencyKey: `${existing.id}:recurred:${observed.version}`,
                payload: {
                  projectId: input.projectId,
                  alertId: existing.id,
                  escalationUserId: existing.escalationUserId
                }
              });
            }
          }
        }
        const stale = await client.projectAlert.findMany({
          where: { projectId: input.projectId, ruleId: rule.id, status: { in: activeStatuses } }
        });
        for (const alert of stale.filter((item) => !keys.has(item.sourceKey))) {
          const resolved = await client.projectAlert.update({
            where: { id: alert.id },
            data: { status: "RESOLVED", resolvedAt: now, version: { increment: 1 } }
          });
          await appendEvent(client, {
            projectId: input.projectId,
            alertId: alert.id,
            eventType: "RESOLVED",
            reason: "预警源已恢复。",
            snapshot: { sourceKey: alert.sourceKey },
            actorId: null
          });
          await writeAlertLifecycleAudit(client, {
            projectId: input.projectId,
            alert: resolved,
            eventType: "RESOLVED",
            reason: "预警源已恢复。",
            actorId: null
          });
          await appendOutboxEvent(client, {
            eventType: "governance.alert.resolved",
            aggregateType: "PROJECT_ALERT",
            aggregateId: alert.id,
            idempotencyKey: `${alert.id}:resolved:${resolved.version}`,
            payload: { projectId: input.projectId, alertId: alert.id }
          });
        }
        const due = await client.projectAlert.findMany({
          where: {
            projectId: input.projectId,
            ruleId: rule.id,
            status: { in: activeStatuses },
            escalatedAt: null
          }
        });
        for (const alert of due.filter(
          (item) =>
            now.getTime() - item.firstTriggeredAt.getTime() >= rule.escalationAfterDays * 86_400_000
        )) {
          const escalated = await client.projectAlert.update({
            where: { id: alert.id },
            data: { escalatedAt: now, version: { increment: 1 } }
          });
          await appendEvent(client, {
            projectId: input.projectId,
            alertId: alert.id,
            eventType: "ESCALATED",
            reason: "预警达到配置的升级时限。",
            snapshot: { escalationAfterDays: rule.escalationAfterDays },
            actorId: null
          });
          await writeAlertLifecycleAudit(client, {
            projectId: input.projectId,
            alert: escalated,
            eventType: "ESCALATED",
            reason: "预警达到配置的升级时限。",
            actorId: null
          });
          await appendOutboxEvent(client, {
            eventType: "governance.alert.escalated",
            aggregateType: "PROJECT_ALERT",
            aggregateId: alert.id,
            idempotencyKey: `${alert.id}:escalated:${escalated.version}`,
            payload: {
              projectId: input.projectId,
              alertId: alert.id,
              recipientUserId: alert.escalationUserId
            }
          });
        }
      }
      const completed = await client.projectAlertScan.update({
        where: { id: scan.id },
        data: { status: "SUCCEEDED", completedAt: now }
      });
      await writeAudit(client, {
        action: AUDIT_ACTIONS.ALERT_SCAN_COMPLETED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_ALERT_SCAN,
        objectId: scan.id,
        context: workerAuditContext(input.projectId, scan.requestedById, "预警扫描完成"),
        after: {
          value: { projectId: input.projectId, scanId: scan.id },
          allowedFields: ALERT_AUDIT_FIELDS
        }
      });
      return { scan: completed, repeated: false, triggeredCount };
    });
  } catch (error) {
    try {
      await db.$transaction(async (client) => {
        const scan = await client.projectAlertScan.findFirst({
          where: { id: input.scanId, projectId: input.projectId }
        });
        if (!scan || scan.status === "SUCCEEDED" || scan.status === "FAILED") return;
        const now = await databaseNow(client);
        const message = error instanceof Error ? error.message.slice(0, 1024) : "预警扫描失败。";
        const failed = await client.projectAlertScan.update({
          where: { id: scan.id },
          data: {
            status: "FAILED",
            completedAt: now,
            errorCode: "ALERT_SCAN_FAILED",
            errorMessage: message
          }
        });
        await writeAudit(client, {
          action: AUDIT_ACTIONS.ALERT_SCAN_COMPLETED,
          objectType: AUDIT_OBJECT_TYPES.PROJECT_ALERT_SCAN,
          objectId: failed.id,
          result: AUDIT_RESULTS.FAILURE,
          context: workerAuditContext(input.projectId, scan.requestedById, message),
          after: {
            value: {
              projectId: input.projectId,
              scanId: scan.id,
              status: failed.status,
              errorCode: failed.errorCode
            },
            allowedFields: ALERT_AUDIT_FIELDS
          }
        });
      });
    } catch {
      // Preserve the original failure when the failure-recording transaction is unavailable.
    }
    throw error;
  }
}

type AssetImpactProjectionInput = {
  projectId: string;
  impactId: string;
  eventAssessmentRevisionId: string | null;
  sourceEventType:
    | "asset.impact.assessed"
    | "asset.impact.disposition-recorded"
    | "asset.impact.risk-acceptance.decided"
    | "project.asset-upgrade.adopted"
    | "asset.impact.closed";
  sourceJobId: string;
  jobAttemptId: string;
  traceId: string | null;
};

function assetImpactSourceSnapshot(
  source: AssetImpactAlertSource,
  input: AssetImpactProjectionInput
): Record<string, unknown> {
  return {
    projectId: source.projectId,
    projectStatus: source.projectStatus,
    impactId: source.impactId,
    impactVersion: source.impactVersion,
    technicalAssetId: source.technicalAssetId,
    impactSourceType: source.impactSourceType,
    impactSourceKey: source.impactSourceKey,
    impactStatus: source.impactStatus,
    assessmentRevisionId: source.assessmentRevisionId,
    assessmentSequence: source.assessmentSequence,
    assessmentSnapshotChecksum: source.snapshotChecksum,
    assessmentSourceWatermark: source.sourceWatermark,
    frozenAt: source.frozenAt.toISOString(),
    ownerMembershipId: source.ownerMembershipId,
    dueAt: source.dueAt?.toISOString() ?? null,
    historicalOnly: source.historicalOnly,
    manualAssignmentRequired: source.manualAssignmentRequired,
    sourceJobId: input.sourceJobId,
    sourceEventType: input.sourceEventType,
    desiredState: source.desiredState
  };
}

function assetImpactProjectionKey(
  source: AssetImpactAlertSource,
  input: AssetImpactProjectionInput,
  rule: { id: string; version: number } | null
) {
  return buildAssetImpactProjectionAttemptKey({
    impactId: source.impactId,
    assessmentRevisionId: source.assessmentRevisionId,
    assessmentSequence: source.assessmentSequence,
    snapshotChecksum: source.snapshotChecksum,
    sourceWatermark: source.sourceWatermark,
    desiredState: source.desiredState,
    sourceJobId: input.sourceJobId,
    sourceEventType: input.sourceEventType,
    ruleId: rule?.id,
    ruleVersion: rule?.version
  });
}

function projectionAuditContext(
  input: AssetImpactProjectionInput,
  source: AssetImpactAlertSource,
  reason: string
): AuditContext {
  return {
    actorId: null,
    requestId: input.sourceJobId,
    traceId: input.traceId,
    source: AUDIT_SOURCES.WORKER,
    sourceIp: null,
    userAgent: null,
    reason,
    projectId: source.projectId,
    departmentId: null,
    operationId: sanitizeAuditText(input.jobAttemptId, 191) || null
  };
}

function projectionAttemptFacts(
  source: AssetImpactAlertSource,
  projection: AssetImpactProjectionInput,
  facts: {
    alertId?: string | null;
    ruleId?: string | null;
    ruleVersion?: number | null;
    result: "DELIVERED" | "BLOCKED_CONFIGURATION" | "FAILED_TRANSIENT";
    blockedReason?: string | null;
    idempotencyKey: string;
  }
) {
  return {
    projectId: source.projectId,
    impactId: source.impactId,
    alertId: facts.alertId ?? null,
    alertRuleId: facts.ruleId ?? null,
    ruleVersion: facts.ruleVersion ?? null,
    sourceKey: source.alertSourceKey,
    assessmentRevisionId: source.assessmentRevisionId,
    assessmentSequence: source.assessmentSequence,
    assessmentSnapshotChecksum: source.snapshotChecksum,
    assessmentSourceWatermark: source.sourceWatermark,
    desiredState: source.desiredState,
    sourceJobId: projection.sourceJobId,
    sourceEventType: projection.sourceEventType,
    result: facts.result,
    blockedReason: facts.blockedReason ?? null,
    idempotencyKey: facts.idempotencyKey
  };
}

async function projectionMembership(
  client: Prisma.TransactionClient,
  projectId: string,
  membershipId: string
) {
  const membership = await client.projectMember.findFirst({
    where: { id: membershipId, projectId, leftAt: null, user: { status: "ACTIVE" } },
    select: {
      id: true,
      userId: true,
      projectId: true,
      projectRole: true,
      departmentId: true,
      joinedAt: true
    }
  });
  return membership ? { ...membership, joinedAt: membership.joinedAt.toISOString() } : null;
}

async function writeProjectionReplayAudit(
  client: Prisma.TransactionClient,
  source: AssetImpactAlertSource,
  input: AssetImpactProjectionInput,
  attempt: {
    id: string;
    ruleId: string | null;
    ruleVersion: number | null;
    result: "DELIVERED" | "BLOCKED_CONFIGURATION" | "FAILED_TRANSIENT";
    blockedReason: string | null;
    idempotencyKey: string;
  }
) {
  await writeAudit(client, {
    action: AUDIT_ACTIONS.ASSET_IMPACT_ALERT_PROJECTION_REPLAYED,
    objectType: AUDIT_OBJECT_TYPES.ASSET_IMPACT_ALERT_PROJECTION_ATTEMPT,
    objectId: attempt.id,
    context: projectionAuditContext(input, source, "资产影响预警投影重放。"),
    after: {
      value: projectionAttemptFacts(source, input, {
        ruleId: attempt.ruleId,
        ruleVersion: attempt.ruleVersion,
        result: attempt.result,
        blockedReason: attempt.blockedReason,
        idempotencyKey: attempt.idempotencyKey
      }),
      allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS
    }
  });
}

async function recordBlockedProjection(
  client: Prisma.TransactionClient,
  source: AssetImpactAlertSource,
  input: AssetImpactProjectionInput,
  rule: { id: string; version: number } | null,
  blockedReason: string
) {
  const idempotencyKey = assetImpactProjectionKey(source, input, rule);
  const existing = await client.assetImpactAlertProjectionAttempt.findUnique({
    where: { idempotencyKey }
  });
  if (existing) {
    await writeProjectionReplayAudit(client, source, input, existing);
    return { repeated: true, attemptId: existing.id };
  }
  const attempt = await client.assetImpactAlertProjectionAttempt.create({
    data: {
      impactId: source.impactId,
      projectId: source.projectId,
      technicalAssetId: source.technicalAssetId,
      assessmentRevisionId: source.assessmentRevisionId,
      assessmentSequence: source.assessmentSequence,
      assessmentSnapshotChecksum: source.snapshotChecksum,
      assessmentSourceWatermark: source.sourceWatermark,
      sourceKey: source.alertSourceKey,
      desiredState: source.desiredState,
      sourceJobId: input.sourceJobId,
      sourceEventType: input.sourceEventType,
      ruleId: rule?.id ?? null,
      ruleVersion: rule?.version ?? null,
      result: "BLOCKED_CONFIGURATION",
      blockedReason,
      idempotencyKey
    }
  });
  await writeAudit(client, {
    action: AUDIT_ACTIONS.ASSET_IMPACT_ALERT_PROJECTION_BLOCKED,
    objectType: AUDIT_OBJECT_TYPES.ASSET_IMPACT_ALERT_PROJECTION_ATTEMPT,
    objectId: attempt.id,
    result: AUDIT_RESULTS.FAILURE,
    context: projectionAuditContext(input, source, blockedReason),
    after: {
      value: projectionAttemptFacts(source, input, {
        ruleId: rule?.id,
        ruleVersion: rule?.version,
        result: "BLOCKED_CONFIGURATION",
        blockedReason,
        idempotencyKey
      }),
      allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS
    }
  });
  return { repeated: false, attemptId: attempt.id };
}

function projectedAssessmentRevisionId(snapshot: Prisma.JsonValue): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, Prisma.JsonValue>).assessmentRevisionId;
  return typeof value === "string" ? value : null;
}

async function recordDeliveredProjection(
  client: Prisma.TransactionClient,
  source: AssetImpactAlertSource,
  input: AssetImpactProjectionInput,
  rule: { id: string; version: number },
  alertId: string | null,
  idempotencyKey: string
) {
  const attempt = await client.assetImpactAlertProjectionAttempt.create({
    data: {
      impactId: source.impactId,
      projectId: source.projectId,
      technicalAssetId: source.technicalAssetId,
      assessmentRevisionId: source.assessmentRevisionId,
      assessmentSequence: source.assessmentSequence,
      assessmentSnapshotChecksum: source.snapshotChecksum,
      assessmentSourceWatermark: source.sourceWatermark,
      sourceKey: source.alertSourceKey,
      desiredState: source.desiredState,
      sourceJobId: input.sourceJobId,
      sourceEventType: input.sourceEventType,
      ruleId: rule.id,
      ruleVersion: rule.version,
      result: "DELIVERED",
      idempotencyKey
    }
  });
  await writeAudit(client, {
    action: AUDIT_ACTIONS.ASSET_IMPACT_ALERT_PROJECTED,
    objectType: AUDIT_OBJECT_TYPES.ASSET_IMPACT_ALERT_PROJECTION_ATTEMPT,
    objectId: attempt.id,
    context: projectionAuditContext(input, source, "资产影响预警投影完成。"),
    after: {
      value: projectionAttemptFacts(source, input, {
        alertId,
        ruleId: rule.id,
        ruleVersion: rule.version,
        result: "DELIVERED",
        idempotencyKey
      }),
      allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS
    }
  });
  return attempt;
}

export async function projectAssetImpact(
  input: AssetImpactProjectionInput,
  transaction?: Prisma.TransactionClient
) {
  return inTransaction(transaction, async (client) => {
    const source = await readAssetImpactAlertSource(client, input);
    const snapshot = assetImpactSourceSnapshot(source, input);
    await client.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "project_alert_rules"
      WHERE "project_id" = ${source.projectId}
        AND "source_type"::text = ${ALERT_SOURCE_TYPES.ASSET_IMPACT}
      ORDER BY "id"
      FOR UPDATE
    `;
    const rules = await client.projectAlertRule.findMany({
      where: {
        projectId: source.projectId,
        sourceType: ALERT_SOURCE_TYPES.ASSET_IMPACT,
        status: "ENABLED"
      },
      orderBy: { id: "asc" }
    });
    if (rules.length === 0) {
      const blocked = await recordBlockedProjection(
        client,
        source,
        input,
        null,
        "ASSET_IMPACT_ALERT_RULE_MISSING"
      );
      return { deliveredCount: 0, blockedCount: 1, repeatedCount: blocked.repeated ? 1 : 0 };
    }

    const now = await databaseNow(client);
    let deliveredCount = 0;
    let blockedCount = 0;
    let repeatedCount = 0;
    for (const rule of rules) {
      const idempotencyKey = assetImpactProjectionKey(source, input, rule);
      const existingAttempt = await client.assetImpactAlertProjectionAttempt.findUnique({
        where: { idempotencyKey }
      });
      if (existingAttempt) {
        await writeProjectionReplayAudit(client, source, input, existingAttempt);
        repeatedCount++;
        continue;
      }

      let conditionValid = true;
      try {
        validateAlertRuleConfig(rule.sourceType, rule.conditionJson);
      } catch {
        conditionValid = false;
      }
      const [owner, escalation] = await Promise.all([
        projectionMembership(client, source.projectId, rule.ownerMembershipId),
        projectionMembership(client, source.projectId, rule.escalationMembershipId)
      ]);
      const blockedReason = !conditionValid
        ? "ASSET_IMPACT_ALERT_RULE_CONDITION_INVALID"
        : !owner
          ? "ASSET_IMPACT_ALERT_OWNER_MEMBERSHIP_INVALID"
          : !escalation
            ? "ASSET_IMPACT_ALERT_ESCALATION_MEMBERSHIP_INVALID"
            : null;
      if (blockedReason || !owner || !escalation) {
        await recordBlockedProjection(client, source, input, rule, blockedReason ?? "INVALID_RULE");
        blockedCount++;
        continue;
      }

      await client.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "project_alerts"
        WHERE "project_id" = ${source.projectId}
          AND "rule_id" = ${rule.id}
          AND "source_key" = ${source.alertSourceKey}
        FOR UPDATE
      `;
      const existingAlert = await client.projectAlert.findUnique({
        where: {
          projectId_ruleId_sourceKey: {
            projectId: source.projectId,
            ruleId: rule.id,
            sourceKey: source.alertSourceKey
          }
        }
      });
      let alert = existingAlert;
      let eventType: ProjectAlertEventType | null = null;
      let reason = "资产影响评估投影已更新。";
      if (source.desiredState === "ACTIVE") {
        if (!existingAlert) {
          alert = await client.projectAlert.create({
            data: {
              projectId: source.projectId,
              ruleId: rule.id,
              sourceType: ALERT_SOURCE_TYPES.ASSET_IMPACT,
              sourceKey: source.alertSourceKey,
              sourceSnapshot: snapshot as Prisma.InputJsonValue,
              probability: rule.probability,
              impact: rule.impact,
              ownerUserId: owner.userId,
              ownerMembershipSnapshot: owner as Prisma.InputJsonValue,
              escalationUserId: escalation.userId,
              escalationMembershipSnapshot: escalation as Prisma.InputJsonValue,
              firstTriggeredAt: now,
              lastObservedAt: now
            }
          });
          eventType = "TRIGGERED";
          reason = "资产影响评估触发项目预警。";
        } else if (existingAlert.status === "RESOLVED" || existingAlert.status === "CLOSED") {
          const hasNewAssessmentRevision =
            projectedAssessmentRevisionId(existingAlert.sourceSnapshot) !==
            source.assessmentRevisionId;
          if (hasNewAssessmentRevision) {
            const isClosed = existingAlert.status === "CLOSED";
            alert = await client.projectAlert.update({
              where: { id: existingAlert.id },
              data: isClosed
                ? {
                    sourceSnapshot: snapshot as Prisma.InputJsonValue,
                    lastObservedAt: now,
                    version: { increment: 1 }
                  }
                : {
                    status: nextAlertStatus(existingAlert.status, "RETRIGGER"),
                    sourceSnapshot: snapshot as Prisma.InputJsonValue,
                    lastObservedAt: now,
                    acknowledgedAt: null,
                    resolvedAt: null,
                    escalatedAt: null,
                    version: { increment: 1 }
                  }
            });
            eventType = "RETRIGGERED";
            reason = isClosed
              ? "已关闭预警收到新的资产影响评估修订，保留关闭事实并追加复发事件。"
              : "新的资产影响评估修订重新触发项目预警。";
          } else {
            alert = await client.projectAlert.update({
              where: { id: existingAlert.id },
              data: { sourceSnapshot: snapshot as Prisma.InputJsonValue, lastObservedAt: now }
            });
          }
        } else {
          alert = await client.projectAlert.update({
            where: { id: existingAlert.id },
            data: {
              sourceSnapshot: snapshot as Prisma.InputJsonValue,
              lastObservedAt: now
            }
          });
        }
      } else if (existingAlert && activeStatuses.includes(existingAlert.status)) {
        alert = await client.projectAlert.update({
          where: { id: existingAlert.id },
          data: {
            status: "RESOLVED",
            sourceSnapshot: snapshot as Prisma.InputJsonValue,
            lastObservedAt: now,
            resolvedAt: now,
            version: { increment: 1 }
          }
        });
        eventType = "RESOLVED";
        reason = "资产影响已进入已缓解或已关闭状态。";
      } else if (existingAlert) {
        alert = await client.projectAlert.update({
          where: { id: existingAlert.id },
          data: {
            sourceSnapshot: snapshot as Prisma.InputJsonValue,
            lastObservedAt: now
          }
        });
      }

      if (alert && eventType) {
        await appendEvent(client, {
          projectId: source.projectId,
          alertId: alert.id,
          eventType,
          reason,
          snapshot,
          actorId: null
        });
        await writeAlertLifecycleAudit(client, {
          projectId: source.projectId,
          alert,
          eventType,
          reason,
          actorId: null,
          auditContext: projectionAuditContext(input, source, reason),
          sourceSnapshot: snapshot
        });
        const outboxEventType =
          eventType === "RESOLVED"
            ? "governance.alert.resolved"
            : eventType === "RETRIGGERED" && alert.status === "CLOSED"
              ? "governance.alert.recurred"
              : "governance.alert.triggered";
        await appendOutboxEvent(client, {
          eventType: outboxEventType,
          aggregateType: "PROJECT_ALERT",
          aggregateId: alert.id,
          idempotencyKey: `${idempotencyKey}:${eventType.toLowerCase()}`,
          payload: {
            projectId: source.projectId,
            alertId: alert.id,
            ownerUserId: alert.ownerUserId,
            escalationUserId: alert.escalationUserId,
            assessmentRevisionId: source.assessmentRevisionId,
            assessmentSequence: source.assessmentSequence,
            assessmentSnapshotChecksum: source.snapshotChecksum,
            assessmentSourceWatermark: source.sourceWatermark,
            desiredState: source.desiredState
          }
        });
      }
      await recordDeliveredProjection(
        client,
        source,
        input,
        rule,
        alert?.id ?? null,
        idempotencyKey
      );
      deliveredCount++;
    }
    return { deliveredCount, blockedCount, repeatedCount };
  });
}

export async function transitionProjectAlert(
  input: {
    projectId: string;
    alertId: string;
    action: AlertAction;
    version: number;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const reason = text(input.reason, "reason", 1024);
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new AlertValidationError("version 必须是正整数。");
  }
  return inTransaction(transaction, async (client) => {
    const alert = await client.projectAlert.findFirst({
      where: { id: input.alertId, projectId: input.projectId }
    });
    if (!alert) throw new AlertServiceError("ALERT_NOT_FOUND", "预警不存在或不属于该项目。", 404);
    const actorMembership = await client.projectMember.findFirst({
      where: { projectId: input.projectId, userId: input.actorId, leftAt: null },
      select: { projectRole: true }
    });
    const manager =
      actorMembership?.projectRole === "PROJECT_MANAGER" ||
      actorMembership?.projectRole === "DEPARTMENT_LEAD";
    if (!manager && alert.ownerUserId !== input.actorId) {
      throw new AlertServiceError(
        "ALERT_OWNER_FORBIDDEN",
        "仅预警责任人或项目管理角色可以处理该预警。",
        403
      );
    }
    if (input.action === "CLOSE" && !manager) {
      throw new AlertServiceError(
        "ALERT_CLOSE_FORBIDDEN",
        "仅项目经理或部门负责人可以关闭预警。",
        403
      );
    }
    const next = nextAlertStatus(alert.status, input.action);
    const now = await databaseNow(client);
    const updated = await client.projectAlert.updateMany({
      where: { id: alert.id, version: input.version },
      data: {
        status: next,
        version: { increment: 1 },
        ...(next === "ACKNOWLEDGED" ? { acknowledgedAt: now } : {}),
        ...(next === "RESOLVED" ? { resolvedAt: now } : {}),
        ...(next === "CLOSED" ? { closedAt: now } : {})
      }
    });
    if (updated.count !== 1)
      throw new AlertServiceError("VERSION_CONFLICT", "预警已被其他操作更新。", 409);
    const current = await client.projectAlert.findUniqueOrThrow({ where: { id: alert.id } });
    const eventType: ProjectAlertEventType =
      input.action === "ACKNOWLEDGE"
        ? "ACKNOWLEDGED"
        : input.action === "START"
          ? "STARTED"
          : input.action === "RESOLVE"
            ? "RESOLVED"
            : input.action === "CLOSE"
              ? "CLOSED"
              : "RETRIGGERED";
    await appendEvent(client, {
      projectId: input.projectId,
      alertId: alert.id,
      eventType,
      reason,
      snapshot: { status: current.status, version: current.version },
      actorId: input.actorId
    });
    const audit = await writeAlertLifecycleAudit(client, {
      projectId: input.projectId,
      alert: current,
      eventType,
      reason,
      actorId: input.actorId,
      auditContext: {
        ...input.auditContext,
        actorId: input.actorId,
        projectId: input.projectId,
        reason
      }
    });
    return { alert: current, auditId: audit.id };
  });
}

export async function listProjectAlertTodos(projectId: string, actorId: string) {
  const [items, latestScan] = await Promise.all([
    db.projectAlert.findMany({
      where: { projectId, ownerUserId: actorId, status: { in: activeStatuses } },
      orderBy: [{ escalatedAt: "desc" }, { firstTriggeredAt: "asc" }]
    }),
    db.projectAlertScan.findFirst({ where: { projectId }, orderBy: { requestedAt: "desc" } })
  ]);
  return {
    items,
    freshness: latestScan
      ? {
          status: latestScan.status,
          requestedAt: latestScan.requestedAt,
          completedAt: latestScan.completedAt,
          errorCode: latestScan.errorCode
        }
      : { status: "NOT_REQUESTED", requestedAt: null, completedAt: null, errorCode: null }
  };
}

export async function findProjectAlertOwnerId(projectId: string, alertId: string) {
  const alert = await db.projectAlert.findFirst({
    where: { id: alertId, projectId },
    select: { ownerUserId: true }
  });
  return alert?.ownerUserId ?? null;
}

export async function listProjectAlerts(projectId: string, actorId: string) {
  const [items, todos, latestScan] = await Promise.all([
    db.projectAlert.findMany({
      where: { projectId },
      orderBy: [{ status: "asc" }, { escalatedAt: "desc" }, { lastObservedAt: "desc" }],
      include: { rule: { select: { code: true, name: true, status: true } } }
    }),
    db.projectAlert.findMany({
      where: { projectId, ownerUserId: actorId, status: { in: activeStatuses } },
      orderBy: [{ escalatedAt: "desc" }, { firstTriggeredAt: "asc" }]
    }),
    db.projectAlertScan.findFirst({ where: { projectId }, orderBy: { requestedAt: "desc" } })
  ]);
  return {
    items,
    todos,
    freshness: latestScan
      ? {
          status: latestScan.status,
          requestedAt: latestScan.requestedAt,
          completedAt: latestScan.completedAt,
          errorCode: latestScan.errorCode,
          errorMessage: latestScan.errorMessage
        }
      : {
          status: "NOT_REQUESTED",
          requestedAt: null,
          completedAt: null,
          errorCode: null,
          errorMessage: null
        }
  };
}
