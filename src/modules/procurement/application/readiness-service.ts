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
import { payloadHash } from "@/modules/governance/domain/idempotency";

import {
  calculateReadiness,
  type ReadinessCalculation,
  type ReadinessRequirementLine
} from "../domain/readiness";
import { parseQuantity } from "../domain/quantity";

export const READINESS_FORMULA_VERSION = "PROCUREMENT.READINESS@1";
const readinessTransactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
} as const;

type ScopeType = "PROJECT" | "DELIVERY_UNIT" | "MACHINE" | "MODULE" | "REQUIREMENT";
type ReadinessStatus = "READY" | "BLOCKED" | "EMPTY" | "INVALID_INPUT" | "STALE" | "FAILED";

export class ProcurementReadinessError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "ProcurementReadinessError";
  }
}

export type ConfigureReadinessPolicyInput = Readonly<{
  projectId: string;
  inspectionRequired: boolean;
  arrivalAutoUsable: boolean;
  criticalRule: Readonly<Record<string, unknown>>;
  dueGraceDays: number;
  gateThreshold: Readonly<Record<string, unknown>>;
  formulaVersion?: string;
  reason: string;
  actorId: string;
  auditContext: AuditContext;
}>;

export type ReadinessPolicyCommandResult = Readonly<{
  policy: {
    id: string;
    projectId: string;
    version: number;
    formulaVersion: string;
  };
  auditId: string;
}>;

export type RequestReadinessRecalculationInput = Readonly<{
  projectId: string;
  actorId: string;
  reason: string;
  auditContext: AuditContext;
}>;

export type ReadinessRequestResult = Readonly<{
  projectId: string;
  inputWatermark: string;
  formulaVersion: string;
  policyVersionId: string;
  outboxEventId: string;
}>;

export type AppendReadinessRecalculationRequestInput = Readonly<{
  projectId: string;
  cause: string;
  idempotencyKey: string;
  traceId?: string | null;
}>;

export type CalculateReadinessInput = Readonly<{
  projectId: string;
  inputWatermark?: string;
  formulaVersion?: string;
  auditContext?: AuditContext;
}>;

export type PublishedReadinessResult = Readonly<{
  projectId: string;
  inputWatermark: string;
  formulaVersion: string;
  status: "PUBLISHED" | "IDEMPOTENT" | "SUPERSEDED" | "FAILED";
  results: readonly ReadinessResultFact[];
  auditId: string | null;
  outboxEventId: string | null;
}>;

export type ProcurementOverviewQuery = Readonly<{
  projectId: string;
}>;

export type ReadinessTreeQuery = Readonly<{
  projectId: string;
}>;

export type ProcurementGateFactsQuery = Readonly<{
  projectId: string;
}>;

export type ReadinessResultFact = Readonly<{
  id?: string;
  projectId: string;
  scopeType: ScopeType;
  scopeId: string;
  policyVersionId: string;
  formulaVersion: string;
  inputWatermark: string;
  status: ReadinessStatus;
  totalLines: number;
  readyLines: number;
  readinessRate: string;
  criticalTotalLines: number;
  criticalReadyLines: number;
  criticalReadinessRate: string;
  gapLines: number;
  overdueLines: number;
  pendingAcceptanceLines: number;
  blockingCriticalLines: number;
  sourceMode: "LOCAL" | "ERP";
  sourceSyncedAt: string | null;
  calculatedAt: string;
}>;

export type ProcurementOverviewDto = Readonly<{
  projectId: string;
  readiness: ReadinessResultFact | null;
  stale: boolean;
}>;

export type ReadinessTreeDto = Readonly<{
  projectId: string;
  inputWatermark: string | null;
  stale: boolean;
  scopes: readonly ReadinessResultFact[];
}>;

export type ProcurementGateFacts = Readonly<{
  projectId: string;
  status: ReadinessStatus | "NOT_CALCULATED";
  readinessResultId: string | null;
  policyVersion: string | null;
  inputWatermark: string | null;
  formulaVersion: string | null;
  calculatedAt: string | null;
  criticalGapLines: number;
  blockingCriticalLines: number;
  gapLines: number;
  overdueLines: number;
  pendingAcceptanceLines: number;
  sourceSyncedAt: string | null;
  affectedRequirementIds: readonly string[];
  wrongDrawingVersionRequirementIds: readonly string[];
  unresolvedMajorChangeRequirementIds: readonly string[];
  gateThreshold: unknown;
}>;

type ReadinessSnapshot = Readonly<{
  settings: {
    projectId: string;
    mode: "LOCAL" | "ERP";
    sourceSystem: string | null;
    currentReadinessPolicyVersionId: string | null;
  };
  policy: {
    id: string;
    version: number;
    formulaVersion: string;
    dueGraceDays: number;
  };
  watermark: string;
  sourceSyncedAt: Date | null;
  sourceStale: boolean;
  scopes: readonly Readonly<{
    scopeType: ScopeType;
    scopeId: string;
    lines: readonly ReadinessRequirementLine[];
  }>[];
}>;

function text(value: unknown, field: string, maximum = 191): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new ProcurementReadinessError(
      "PROC_READINESS_INVALID_INPUT",
      `${field} 必须是 1 到 ${maximum} 个字符。`
    );
  }
  return value.trim();
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProcurementReadinessError(
      "PROC_READINESS_INVALID_INPUT",
      `${field} 必须是非负整数。`
    );
  }
  return value as number;
}

function objectValue(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProcurementReadinessError("PROC_READINESS_INVALID_INPUT", `${field} 必须是对象。`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function formulaVersion(value: unknown): string {
  return text(value ?? READINESS_FORMULA_VERSION, "formulaVersion", 64);
}

function workerAuditContext(projectId: string): AuditContext {
  return {
    actorId: null,
    requestId: null,
    traceId: null,
    source: "WORKER",
    sourceIp: null,
    userAgent: null,
    reason: null,
    projectId,
    departmentId: null,
    operationId: "procurement.readiness-recalculation"
  };
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

async function assertProcurementContext(client: Prisma.TransactionClient, projectId: string) {
  const [project, projectCapability, companyCapability, settings] = await Promise.all([
    client.project.findUnique({ where: { id: projectId }, select: { id: true, status: true } }),
    client.projectCapability.findUnique({
      where: {
        projectId_capabilityCode: { projectId, capabilityCode: "PROCUREMENT_COLLABORATION" }
      },
      select: { selectedEnabled: true }
    }),
    client.companyCapability.findUnique({
      where: { code: "PROCUREMENT_COLLABORATION" },
      select: { enabled: true }
    }),
    client.projectProcurementSettings.findUnique({
      where: { projectId },
      include: { currentReadinessPolicyVersion: true }
    })
  ]);
  if (!project) throw new ProcurementReadinessError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  if (project.status === ProjectStatus.CLOSED || project.status === ProjectStatus.CANCELED) {
    throw new ProcurementReadinessError(
      "PROJECT_READ_ONLY",
      "已关闭或取消项目不能计算采购齐套。",
      409
    );
  }
  if (!companyCapability?.enabled || !projectCapability?.selectedEnabled) {
    throw new ProcurementReadinessError(
      "PROC_CAPABILITY_DISABLED",
      "项目采购与物料协同能力未有效启用。",
      409
    );
  }
  if (!settings) {
    throw new ProcurementReadinessError(
      "PROC_SETTINGS_NOT_CONFIGURED",
      "项目采购模式尚未配置。",
      409
    );
  }
  return settings;
}

function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function scopeKey(scopeType: ScopeType, scopeId: string): string {
  return `${scopeType}:${scopeId}`;
}

function resultFact(
  snapshot: ReadinessSnapshot,
  scope: ReadinessSnapshot["scopes"][number],
  calculatedAt: Date
): ReadinessResultFact {
  const calculation = calculateReadiness({
    lines: scope.lines,
    sourceSyncedAt: snapshot.sourceSyncedAt?.toISOString() ?? null,
    staleAfterDays: snapshot.sourceStale ? 0 : undefined,
    now: calculatedAt.toISOString()
  });
  const byRequirement = new Map(scope.lines.map((line) => [line.id, line]));
  const resultLines = calculation.lines;
  const status: ReadinessStatus = snapshot.sourceStale ? "STALE" : calculation.status;
  return calculationFact(
    snapshot,
    scope,
    calculation,
    resultLines,
    byRequirement,
    calculatedAt,
    status
  );
}

function calculationFact(
  snapshot: ReadinessSnapshot,
  scope: ReadinessSnapshot["scopes"][number],
  calculation: ReadinessCalculation,
  resultLines: ReadonlyArray<ReadinessCalculation["lines"][number]>,
  byRequirement: ReadonlyMap<string, ReadinessRequirementLine>,
  calculatedAt: Date,
  status: ReadinessStatus
): ReadinessResultFact {
  const now = calculatedAt.toISOString().slice(0, 10);
  const gapLines = resultLines.filter((line) => !line.isReady).length;
  const overdueLines = resultLines.filter((line) => {
    const source = byRequirement.get(line.requirementId);
    if (!source?.requiredOn) return false;
    return (!line.isReady && source.requiredOn < now) || (line.isReady && line.isOnTime === false);
  }).length;
  const pendingAcceptanceLines = resultLines.filter(
    (line) => parseQuantity(line.arrivedQuantity) > parseQuantity(line.usableQuantity)
  ).length;
  return {
    projectId: snapshot.settings.projectId,
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    policyVersionId: snapshot.policy.id,
    formulaVersion: snapshot.policy.formulaVersion,
    inputWatermark: snapshot.watermark,
    status,
    totalLines: calculation.totalLines,
    readyLines: calculation.readyLines,
    readinessRate: calculation.readinessRate,
    criticalTotalLines: calculation.criticalTotalLines,
    criticalReadyLines: calculation.criticalReadyLines,
    criticalReadinessRate: calculation.criticalReadinessRate,
    gapLines,
    overdueLines,
    pendingAcceptanceLines,
    blockingCriticalLines: calculation.blockingCriticalLines,
    sourceMode: snapshot.settings.mode,
    sourceSyncedAt: snapshot.sourceSyncedAt?.toISOString() ?? null,
    calculatedAt: calculatedAt.toISOString()
  };
}

async function snapshotReadinessInput(
  client: Prisma.TransactionClient,
  projectId: string
): Promise<ReadinessSnapshot> {
  const settings = await assertProcurementContext(client, projectId);
  const policy = settings.currentReadinessPolicyVersion;
  if (!policy || !settings.currentReadinessPolicyVersionId) {
    throw new ProcurementReadinessError(
      "PROC_READINESS_POLICY_NOT_CONFIGURED",
      "项目尚未冻结齐套政策。",
      409
    );
  }
  const [requirements, events, trackingLines, deliveryUnits, modules, syncStates] =
    await Promise.all([
      client.projectMaterialRequirement.findMany({
        where: { projectId, status: "CONFIRMED" },
        include: { currentRevision: true },
        orderBy: { id: "asc" }
      }),
      client.procurementFulfillmentEvent.findMany({
        where: { projectId },
        orderBy: [{ businessOccurredAt: "asc" }, { id: "asc" }]
      }),
      client.procurementTrackingLine.findMany({ where: { projectId }, orderBy: { id: "asc" } }),
      client.deliveryUnit.findMany({
        where: { projectId, status: "ACTIVE" },
        select: { id: true, parentId: true, unitType: true, version: true, updatedAt: true },
        orderBy: { id: "asc" }
      }),
      client.projectModule.findMany({
        where: { projectId, status: "ACTIVE" },
        select: { id: true, deliveryUnitId: true, version: true, updatedAt: true },
        orderBy: { id: "asc" }
      }),
      settings.mode === "ERP" && settings.sourceSystem
        ? client.procurementSyncState.findMany({ where: { sourceSystem: settings.sourceSystem } })
        : Promise.resolve([])
    ]);
  const requirementsWithRevision = requirements.filter(
    (
      requirement
    ): requirement is typeof requirement & {
      currentRevision: NonNullable<typeof requirement.currentRevision>;
    } => requirement.currentRevision !== null && requirement.currentRevision.status === "CONFIRMED"
  );
  const currentRevisionIds = new Set(
    requirementsWithRevision.map((value) => value.currentRevision.id)
  );
  const eventsByRequirement = new Map<string, typeof events>();
  for (const event of events) {
    if (!currentRevisionIds.has(event.requirementRevisionId)) continue;
    const current = eventsByRequirement.get(event.requirementId) ?? [];
    current.push(event);
    eventsByRequirement.set(event.requirementId, current);
  }
  const usableDates = new Map<string, Date>();
  for (const [requirementId, requirementEvents] of eventsByRequirement) {
    const reversedEventIds = new Set(
      requirementEvents
        .filter((event) => event.eventType === "REVERSED" && event.reversesEventId !== null)
        .map((event) => event.reversesEventId!)
    );
    for (const event of requirementEvents) {
      if (event.eventType !== "ACCEPTED" && event.eventType !== "MARKED_USABLE") continue;
      if (reversedEventIds.has(event.id)) continue;
      const current = usableDates.get(requirementId);
      if (!current || event.businessOccurredAt > current) {
        usableDates.set(requirementId, event.businessOccurredAt);
      }
    }
  }
  const lineByRequirement = new Map<string, ReadinessRequirementLine>();
  for (const requirement of requirementsWithRevision) {
    const revision = requirement.currentRevision;
    lineByRequirement.set(requirement.id, {
      id: requirement.id,
      trackingUnit: revision.trackingUnit,
      requiredQuantity: revision.quantity.toString(),
      isCritical: revision.isCritical,
      isEffective: true,
      requiredOn: dateOnly(revision.requiredOn),
      availableOn: dateOnly(usableDates.get(requirement.id) ?? null),
      events: (eventsByRequirement.get(requirement.id) ?? []).map((event) => ({
        id: event.id,
        eventType: event.eventType,
        quantity: event.quantity.toString(),
        trackingUnit: event.trackingUnit,
        reversesEventId: event.reversesEventId
      }))
    });
  }
  const unitById = new Map(deliveryUnits.map((unit) => [unit.id, unit]));
  const moduleById = new Map(modules.map((projectModule) => [projectModule.id, projectModule]));
  const scopes = new Map<
    string,
    { scopeType: ScopeType; scopeId: string; lines: ReadinessRequirementLine[] }
  >();
  const addScope = (scopeType: ScopeType, scopeId: string, line?: ReadinessRequirementLine) => {
    const key = scopeKey(scopeType, scopeId);
    const scope = scopes.get(key) ?? { scopeType, scopeId, lines: [] };
    if (line) scope.lines.push(line);
    scopes.set(key, scope);
  };
  addScope("PROJECT", projectId);
  for (const unit of deliveryUnits) {
    addScope(unit.unitType === "MACHINE" ? "MACHINE" : "DELIVERY_UNIT", unit.id);
  }
  for (const projectModule of modules) addScope("MODULE", projectModule.id);
  for (const requirement of requirementsWithRevision) {
    const line = lineByRequirement.get(requirement.id)!;
    const revision = requirement.currentRevision;
    addScope("PROJECT", projectId, line);
    addScope("REQUIREMENT", requirement.id, line);
    if (revision.moduleId) addScope("MODULE", revision.moduleId, line);
    let unitId =
      revision.deliveryUnitId ??
      (revision.moduleId ? moduleById.get(revision.moduleId)?.deliveryUnitId : null);
    const visited = new Set<string>();
    while (unitId && !visited.has(unitId)) {
      visited.add(unitId);
      const unit = unitById.get(unitId);
      if (!unit) break;
      addScope(unit.unitType === "MACHINE" ? "MACHINE" : "DELIVERY_UNIT", unit.id, line);
      unitId = unit.parentId;
    }
  }
  const sourceSyncedAt =
    syncStates
      .map((state) => state.lastSuccessfulAt)
      .filter((value): value is Date => value !== null)
      .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
  const sourceStale =
    settings.mode === "ERP" &&
    (syncStates.length === 0 ||
      syncStates.some((state) => state.status === "STALE" || state.status === "FAILED"));
  const watermark = payloadHash({
    projectId,
    settings: {
      mode: settings.mode,
      sourceSystem: settings.sourceSystem,
      currentReadinessPolicyVersionId: settings.currentReadinessPolicyVersionId,
      version: settings.version
    },
    policy: { id: policy.id, version: policy.version, formulaVersion: policy.formulaVersion },
    requirements: requirementsWithRevision.map((requirement) => ({
      id: requirement.id,
      version: requirement.version,
      status: requirement.status,
      revision: {
        id: requirement.currentRevision.id,
        revision: requirement.currentRevision.revision,
        status: requirement.currentRevision.status,
        deliveryUnitId: requirement.currentRevision.deliveryUnitId,
        moduleId: requirement.currentRevision.moduleId,
        responsibilityPackageId: requirement.currentRevision.responsibilityPackageId,
        taskId: requirement.currentRevision.taskId,
        materialReferenceId: requirement.currentRevision.materialReferenceId,
        quantity: requirement.currentRevision.quantity.toString(),
        trackingUnit: requirement.currentRevision.trackingUnit,
        requiredOn: requirement.currentRevision.requiredOn.toISOString(),
        predictedAssemblyStartOn:
          requirement.currentRevision.predictedAssemblyStartOn?.toISOString() ?? null,
        isCritical: requirement.currentRevision.isCritical,
        isLongLead: requirement.currentRevision.isLongLead,
        businessType: requirement.currentRevision.businessType,
        source: requirement.currentRevision.source,
        sourceReference: requirement.currentRevision.sourceReference,
        sourceVersion: requirement.currentRevision.sourceVersion,
        drawingId: requirement.currentRevision.drawingId,
        drawingVersionId: requirement.currentRevision.drawingVersionId,
        outsourcedProcess: requirement.currentRevision.outsourcedProcess,
        createdAt: requirement.currentRevision.createdAt.toISOString()
      }
    })),
    trackingLines: trackingLines.map((line) => ({
      id: line.id,
      version: line.version,
      updatedAt: line.updatedAt.toISOString()
    })),
    events: events.map((event) => ({
      id: event.id,
      requirementId: event.requirementId,
      requirementRevisionId: event.requirementRevisionId,
      eventType: event.eventType,
      quantity: event.quantity.toString(),
      trackingUnit: event.trackingUnit,
      businessOccurredAt: event.businessOccurredAt.toISOString(),
      recordedAt: event.recordedAt.toISOString(),
      reversesEventId: event.reversesEventId
    })),
    deliveryUnits: deliveryUnits.map((unit) => ({
      id: unit.id,
      version: unit.version,
      updatedAt: unit.updatedAt.toISOString()
    })),
    modules: modules.map((projectModule) => ({
      id: projectModule.id,
      version: projectModule.version,
      updatedAt: projectModule.updatedAt.toISOString()
    })),
    syncStates: syncStates.map((state) => ({
      id: state.id,
      version: state.version,
      status: state.status,
      lastSuccessfulAt: state.lastSuccessfulAt?.toISOString() ?? null,
      updatedAt: state.updatedAt.toISOString()
    }))
  }).hash;
  return {
    settings: {
      projectId: settings.projectId,
      mode: settings.mode,
      sourceSystem: settings.sourceSystem,
      currentReadinessPolicyVersionId: settings.currentReadinessPolicyVersionId
    },
    policy: {
      id: policy.id,
      version: policy.version,
      formulaVersion: policy.formulaVersion,
      dueGraceDays: policy.dueGraceDays
    },
    watermark,
    sourceSyncedAt,
    sourceStale,
    scopes: [...scopes.values()].sort((left, right) =>
      scopeKey(left.scopeType, left.scopeId).localeCompare(scopeKey(right.scopeType, right.scopeId))
    )
  };
}

function resultCreateData(result: ReadinessResultFact) {
  return {
    projectId: result.projectId,
    scopeType: result.scopeType,
    scopeId: result.scopeId,
    policyVersionId: result.policyVersionId,
    formulaVersion: result.formulaVersion,
    inputWatermark: result.inputWatermark,
    status: result.status,
    totalLines: result.totalLines,
    readyLines: result.readyLines,
    readinessRate: new Prisma.Decimal(result.readinessRate),
    criticalTotalLines: result.criticalTotalLines,
    criticalReadyLines: result.criticalReadyLines,
    criticalReadinessRate: new Prisma.Decimal(result.criticalReadinessRate),
    gapLines: result.gapLines,
    overdueLines: result.overdueLines,
    pendingAcceptanceLines: result.pendingAcceptanceLines,
    blockingCriticalLines: result.blockingCriticalLines,
    sourceMode: result.sourceMode,
    sourceSyncedAt: result.sourceSyncedAt ? new Date(result.sourceSyncedAt) : null,
    calculatedAt: new Date(result.calculatedAt)
  };
}

export async function configureReadinessPolicy(
  input: ConfigureReadinessPolicyInput,
  transaction?: Prisma.TransactionClient
): Promise<ReadinessPolicyCommandResult> {
  const projectId = text(input.projectId, "projectId");
  const reason = text(input.reason, "reason", 1024);
  const actorId = text(input.actorId, "actorId");
  if (input.inspectionRequired && input.arrivalAutoUsable) {
    throw new ProcurementReadinessError(
      "PROC_READINESS_POLICY_INVALID",
      "启用来料检验时不能配置到货自动可用。"
    );
  }
  const dueGraceDays = nonNegativeInteger(input.dueGraceDays, "dueGraceDays");
  const criticalRule = objectValue(input.criticalRule, "criticalRule");
  const gateThreshold = objectValue(input.gateThreshold, "gateThreshold");
  const selectedFormulaVersion = formulaVersion(input.formulaVersion);
  return inTransaction(transaction, async (client) => {
    const settings = await assertProcurementContext(client, projectId);
    const latest = await client.procurementReadinessPolicyVersion.aggregate({
      where: { projectId },
      _max: { version: true }
    });
    const policy = await client.procurementReadinessPolicyVersion.create({
      data: {
        projectId,
        version: (latest._max.version ?? 0) + 1,
        inspectionRequired: input.inspectionRequired,
        arrivalAutoUsable: input.arrivalAutoUsable,
        criticalRuleJson: criticalRule as Prisma.InputJsonValue,
        dueGraceDays,
        gateThresholdJson: gateThreshold as Prisma.InputJsonValue,
        formulaVersion: selectedFormulaVersion,
        createdById: actorId,
        reason
      }
    });
    await client.projectProcurementSettings.update({
      where: { projectId: settings.projectId },
      data: {
        currentReadinessPolicyVersionId: policy.id,
        updatedById: actorId,
        version: { increment: 1 }
      }
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.PROCUREMENT_SETTINGS_CONFIGURED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_PROCUREMENT_SETTINGS,
      objectId: projectId,
      context: { ...input.auditContext, projectId, actorId, reason },
      after: {
        value: { projectId, readinessPolicyVersionId: policy.id, version: policy.version, reason },
        allowedFields: PROCUREMENT_AUDIT_FIELDS
      }
    });
    await appendReadinessRecalculationRequest(client, {
      projectId,
      cause: "readiness-policy-configured",
      idempotencyKey: policy.id,
      traceId: input.auditContext.traceId
    });
    return {
      policy: {
        id: policy.id,
        projectId: policy.projectId,
        version: policy.version,
        formulaVersion: policy.formulaVersion
      },
      auditId: audit.id
    };
  });
}

export async function appendReadinessRecalculationRequest(
  client: Prisma.TransactionClient,
  input: AppendReadinessRecalculationRequestInput
) {
  const projectId = text(input.projectId, "projectId");
  const cause = text(input.cause, "cause", 64);
  const idempotencyKey = text(input.idempotencyKey, "idempotencyKey", 191);
  return appendOutboxEvent(client, {
    eventType: "procurement.readiness-recalculation.requested",
    aggregateType: "PROCUREMENT_READINESS",
    aggregateId: projectId,
    idempotencyKey: payloadHash({ projectId, cause, idempotencyKey }).hash,
    payload: { projectId },
    traceId: input.traceId
  });
}

function assertNoExternalSnapshotTransaction(transaction: Prisma.TransactionClient | undefined) {
  if (transaction) {
    throw new ProcurementReadinessError(
      "PROC_READINESS_EXTERNAL_TRANSACTION_FORBIDDEN",
      "采购齐套快照必须在服务自有的可重复读事务中执行。",
      409
    );
  }
}

export async function requestReadinessRecalculation(
  input: RequestReadinessRecalculationInput,
  transaction?: Prisma.TransactionClient
): Promise<ReadinessRequestResult> {
  assertNoExternalSnapshotTransaction(transaction);
  const projectId = text(input.projectId, "projectId");
  text(input.actorId, "actorId");
  text(input.reason, "reason", 1024);
  return inTransaction(
    undefined,
    async (client) => {
      const snapshot = await snapshotReadinessInput(client, projectId);
      const outbox = await appendOutboxEvent(client, {
        eventType: "procurement.readiness-recalculation.requested",
        aggregateType: "PROCUREMENT_READINESS",
        aggregateId: projectId,
        idempotencyKey: `${projectId}:${snapshot.watermark}:${snapshot.policy.formulaVersion}`,
        payload: {
          projectId,
          inputWatermark: snapshot.watermark,
          formulaVersion: snapshot.policy.formulaVersion,
          policyVersionId: snapshot.policy.id
        },
        traceId: input.auditContext.traceId
      });
      return {
        projectId,
        inputWatermark: snapshot.watermark,
        formulaVersion: snapshot.policy.formulaVersion,
        policyVersionId: snapshot.policy.id,
        outboxEventId: outbox.id
      };
    },
    readinessTransactionOptions
  );
}

export async function calculateAndPublishReadiness(
  input: CalculateReadinessInput,
  transaction?: Prisma.TransactionClient
): Promise<PublishedReadinessResult> {
  assertNoExternalSnapshotTransaction(transaction);
  const projectId = text(input.projectId, "projectId");
  return inTransaction(
    undefined,
    async (client) => {
      const snapshot = await snapshotReadinessInput(client, projectId);
      if (input.inputWatermark && input.inputWatermark !== snapshot.watermark) {
        return {
          projectId,
          inputWatermark: snapshot.watermark,
          formulaVersion: snapshot.policy.formulaVersion,
          status: "SUPERSEDED",
          results: [],
          auditId: null,
          outboxEventId: null
        };
      }
      if (input.formulaVersion && input.formulaVersion !== snapshot.policy.formulaVersion) {
        return {
          projectId,
          inputWatermark: snapshot.watermark,
          formulaVersion: snapshot.policy.formulaVersion,
          status: "SUPERSEDED",
          results: [],
          auditId: null,
          outboxEventId: null
        };
      }
      const existing = await client.procurementReadinessResult.findFirst({
        where: {
          projectId,
          scopeType: "PROJECT",
          scopeId: projectId,
          inputWatermark: snapshot.watermark,
          formulaVersion: snapshot.policy.formulaVersion
        },
        select: { id: true }
      });
      if (existing) {
        return {
          projectId,
          inputWatermark: snapshot.watermark,
          formulaVersion: snapshot.policy.formulaVersion,
          status: "IDEMPOTENT",
          results: [],
          auditId: null,
          outboxEventId: null
        };
      }
      const calculatedAt = await databaseNow(client);
      let results: ReadinessResultFact[];
      try {
        results = snapshot.scopes.map((scope) => resultFact(snapshot, scope, calculatedAt));
      } catch (_error) {
        results = snapshot.scopes.map((scope) => ({
          projectId,
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          policyVersionId: snapshot.policy.id,
          formulaVersion: snapshot.policy.formulaVersion,
          inputWatermark: snapshot.watermark,
          status: "FAILED" as const,
          totalLines: 0,
          readyLines: 0,
          readinessRate: "0",
          criticalTotalLines: 0,
          criticalReadyLines: 0,
          criticalReadinessRate: "0",
          gapLines: 0,
          overdueLines: 0,
          pendingAcceptanceLines: 0,
          blockingCriticalLines: 0,
          sourceMode: snapshot.settings.mode,
          sourceSyncedAt: snapshot.sourceSyncedAt?.toISOString() ?? null,
          calculatedAt: calculatedAt.toISOString()
        }));
      }
      const inserted = await client.procurementReadinessResult.createMany({
        data: results.map(resultCreateData),
        skipDuplicates: true
      });
      if (inserted.count === 0) {
        return {
          projectId,
          inputWatermark: snapshot.watermark,
          formulaVersion: snapshot.policy.formulaVersion,
          status: "IDEMPOTENT",
          results: [],
          auditId: null,
          outboxEventId: null
        };
      }
      if (inserted.count !== results.length) {
        throw new ProcurementReadinessError(
          "PROC_READINESS_PUBLICATION_CONFLICT",
          "齐套结果发布出现不完整的并发写入。",
          409
        );
      }
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PROCUREMENT_READINESS_CALCULATED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT,
        objectId: projectId,
        context: input.auditContext ?? workerAuditContext(projectId),
        after: {
          value: {
            projectId,
            inputWatermark: snapshot.watermark,
            formulaVersion: snapshot.policy.formulaVersion,
            resultCount: results.length,
            status: results.find((result) => result.scopeType === "PROJECT")?.status ?? "FAILED"
          },
          allowedFields: PROCUREMENT_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "procurement.readiness.published",
        aggregateType: "PROCUREMENT_READINESS",
        aggregateId: projectId,
        idempotencyKey: `${projectId}:${snapshot.watermark}:${snapshot.policy.formulaVersion}`,
        payload: {
          projectId,
          inputWatermark: snapshot.watermark,
          formulaVersion: snapshot.policy.formulaVersion,
          policyVersionId: snapshot.policy.id,
          status: results.find((result) => result.scopeType === "PROJECT")?.status ?? "FAILED"
        },
        traceId: (input.auditContext ?? workerAuditContext(projectId)).traceId
      });
      return {
        projectId,
        inputWatermark: snapshot.watermark,
        formulaVersion: snapshot.policy.formulaVersion,
        status: results.some((result) => result.status === "FAILED") ? "FAILED" : "PUBLISHED",
        results,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    },
    readinessTransactionOptions
  );
}

function toFact(result: {
  id: string;
  projectId: string;
  scopeType: ScopeType;
  scopeId: string;
  policyVersionId: string;
  formulaVersion: string;
  inputWatermark: string;
  status: ReadinessStatus;
  totalLines: number;
  readyLines: number;
  readinessRate: Prisma.Decimal;
  criticalTotalLines: number;
  criticalReadyLines: number;
  criticalReadinessRate: Prisma.Decimal;
  gapLines: number;
  overdueLines: number;
  pendingAcceptanceLines: number;
  blockingCriticalLines: number;
  sourceMode: "LOCAL" | "ERP";
  sourceSyncedAt: Date | null;
  calculatedAt: Date;
}): ReadinessResultFact {
  return {
    ...result,
    readinessRate: result.readinessRate.toString(),
    criticalReadinessRate: result.criticalReadinessRate.toString(),
    sourceSyncedAt: result.sourceSyncedAt?.toISOString() ?? null,
    calculatedAt: result.calculatedAt.toISOString()
  };
}

async function currentReadinessFacts(projectId: string) {
  return inTransaction(
    undefined,
    async (client) => {
      const results = await client.procurementReadinessResult.findMany({
        where: { projectId },
        orderBy: [{ calculatedAt: "desc" }, { id: "desc" }]
      });
      const root = results.find(
        (result) => result.scopeType === "PROJECT" && result.scopeId === projectId
      );
      if (!root) return { facts: [], stale: false };
      const facts = results
        .filter(
          (result) =>
            result.inputWatermark === root.inputWatermark &&
            result.formulaVersion === root.formulaVersion
        )
        .map(toFact)
        .sort((left, right) =>
          scopeKey(left.scopeType, left.scopeId).localeCompare(
            scopeKey(right.scopeType, right.scopeId)
          )
        );
      const snapshot = await snapshotReadinessInput(client, projectId);
      const stale =
        root.inputWatermark !== snapshot.watermark ||
        root.formulaVersion !== snapshot.policy.formulaVersion;
      return {
        facts: stale ? facts.map((fact) => ({ ...fact, status: "STALE" as const })) : facts,
        stale
      };
    },
    readinessTransactionOptions
  );
}

export async function readProjectProcurementOverview(
  input: ProcurementOverviewQuery
): Promise<ProcurementOverviewDto> {
  const projectId = text(input.projectId, "projectId");
  const { facts, stale } = await currentReadinessFacts(projectId);
  const readiness =
    facts.find((result) => result.scopeType === "PROJECT" && result.scopeId === projectId) ?? null;
  return { projectId, readiness, stale };
}

export async function readProcurementReadinessTree(
  input: ReadinessTreeQuery
): Promise<ReadinessTreeDto> {
  const projectId = text(input.projectId, "projectId");
  const { facts: scopes, stale } = await currentReadinessFacts(projectId);
  const root = scopes.find(
    (result) => result.scopeType === "PROJECT" && result.scopeId === projectId
  );
  return { projectId, inputWatermark: root?.inputWatermark ?? null, stale, scopes };
}

export async function readProcurementGateFacts(
  input: ProcurementGateFactsQuery
): Promise<ProcurementGateFacts> {
  const overview = await readProjectProcurementOverview(input);
  const result = overview.readiness;
  const [settings, requirements, openImpacts] = await Promise.all([
    db.projectProcurementSettings.findUnique({
      where: { projectId: overview.projectId },
      include: { currentReadinessPolicyVersion: { select: { gateThresholdJson: true } } }
    }),
    db.projectMaterialRequirement.findMany({
      where: { projectId: overview.projectId, status: "CONFIRMED" },
      select: {
        id: true,
        currentRevision: {
          select: {
            id: true,
            businessType: true,
            drawingId: true,
            drawingVersionId: true
          }
        }
      }
    }),
    db.procurementChangeImpact.findMany({
      where: { projectId: overview.projectId, status: "OPEN" },
      select: { requirementId: true }
    })
  ]);
  const drawingRevisionRows = requirements.flatMap((requirement) =>
    requirement.currentRevision?.businessType === "DRAWING_CUSTOM"
      ? [{ requirementId: requirement.id, ...requirement.currentRevision }]
      : []
  );
  const drawingIds = drawingRevisionRows
    .map((row) => row.drawingId)
    .filter((value): value is string => value !== null);
  const drawingVersionIds = drawingRevisionRows
    .map((row) => row.drawingVersionId)
    .filter((value): value is string => value !== null);
  const [drawings, drawingVersions] = await Promise.all([
    drawingIds.length > 0
      ? db.mechanicalDrawing.findMany({
          where: { projectId: overview.projectId, id: { in: drawingIds } },
          select: { id: true, documentId: true }
        })
      : Promise.resolve([]),
    drawingVersionIds.length > 0
      ? db.controlledDocumentVersion.findMany({
          where: { projectId: overview.projectId, id: { in: drawingVersionIds } },
          select: { id: true, documentId: true, status: true }
        })
      : Promise.resolve([])
  ]);
  const drawingById = new Map(drawings.map((drawing) => [drawing.id, drawing]));
  const drawingVersionById = new Map(drawingVersions.map((version) => [version.id, version]));
  const wrongDrawingVersionRequirementIds = drawingRevisionRows
    .filter((row) => {
      const drawing = row.drawingId ? drawingById.get(row.drawingId) : undefined;
      const version = row.drawingVersionId
        ? drawingVersionById.get(row.drawingVersionId)
        : undefined;
      return (
        !drawing ||
        !version ||
        version.status !== "PUBLISHED" ||
        version.documentId !== drawing.documentId
      );
    })
    .map((row) => row.requirementId)
    .sort((left, right) => left.localeCompare(right));
  const affectedRequirementIds = result
    ? (await readProcurementReadinessTree(input)).scopes
        .filter((fact) => fact.scopeType === "REQUIREMENT" && fact.status !== "READY")
        .map((fact) => fact.scopeId)
        .sort((left, right) => left.localeCompare(right))
    : [];
  const unresolvedMajorChangeRequirementIds = [
    ...new Set(openImpacts.map((impact) => impact.requirementId))
  ].sort((left, right) => left.localeCompare(right));
  const base = {
    projectId: overview.projectId,
    status: result?.status ?? "NOT_CALCULATED",
    readinessResultId: result?.id ?? null,
    policyVersion: result?.policyVersionId ?? null,
    inputWatermark: result?.inputWatermark ?? null,
    formulaVersion: result?.formulaVersion ?? null,
    calculatedAt: result?.calculatedAt ?? null,
    criticalGapLines: result?.blockingCriticalLines ?? 0,
    blockingCriticalLines: result?.blockingCriticalLines ?? 0,
    gapLines: result?.gapLines ?? 0,
    overdueLines: result?.overdueLines ?? 0,
    pendingAcceptanceLines: result?.pendingAcceptanceLines ?? 0,
    sourceSyncedAt: result?.sourceSyncedAt ?? null,
    affectedRequirementIds,
    wrongDrawingVersionRequirementIds,
    unresolvedMajorChangeRequirementIds,
    gateThreshold: settings?.currentReadinessPolicyVersion?.gateThresholdJson ?? null
  } satisfies ProcurementGateFacts;
  return base;
}
