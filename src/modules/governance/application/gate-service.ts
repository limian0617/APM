import { GateCheckStatus, GateScope, Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  GATE_CHECK_SNAPSHOT_AUDIT_FIELDS,
  PROJECT_GATE_INSTANCE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import {
  resolveGateChecker,
  type GateChecker,
  type GateCheckerResultStatus
} from "@/modules/governance/domain/gate-checker-registry";
import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import { readProcurementGateFacts } from "@/modules/procurement/application/readiness-service";
import type { ProjectStageExecutionStatus } from "@/modules/projects/domain/project-stage";

const GATE_SCOPES = ["PROJECT", "DELIVERY_UNIT", "MODULE"] as const;

export type GateScopeCode = (typeof GATE_SCOPES)[number];

export type FrozenGateCheckerBinding = {
  code: string;
  version: number;
};

export type GateScopeTarget = {
  scope: GateScopeCode;
  deliveryUnitId: string | null;
  moduleId: string | null;
};

export type GateCheckResultFact = {
  position: number;
  checkerCode: string;
  checkerVersion: number;
  status: GateCheckerResultStatus;
  failureCode: string | null;
  message: string;
  evidence: JsonValue;
  evidenceChecksum: string;
};

export class GateServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = "GateServiceError";
  }
}

function stableText(value: unknown, field: string, maximumLength = 191): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximumLength) {
    throw new GateServiceError(
      "GATE_INVALID_INPUT",
      `${field} 必须是 1 到 ${maximumLength} 个字符。`,
      422
    );
  }
  return normalized;
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new GateServiceError("GATE_VERSION_INVALID", "version 必须是正整数。", 422);
  }
  return value as number;
}

function commandReason(value: unknown): string {
  return stableText(value, "reason", 1024);
}

function isGateScope(value: unknown): value is GateScopeCode {
  return typeof value === "string" && GATE_SCOPES.includes(value as GateScopeCode);
}

export function validateGateInstanceScopeTarget(input: {
  scope: unknown;
  deliveryUnitId?: unknown;
  moduleId?: unknown;
}): GateScopeTarget {
  if (!isGateScope(input.scope)) {
    throw new GateServiceError("GATE_SCOPE_INVALID", "Gate 范围无效。", 422);
  }
  const deliveryUnitId =
    input.deliveryUnitId === null || input.deliveryUnitId === undefined
      ? null
      : stableText(input.deliveryUnitId, "deliveryUnitId");
  const moduleId =
    input.moduleId === null || input.moduleId === undefined
      ? null
      : stableText(input.moduleId, "moduleId");

  if (input.scope === "PROJECT") {
    throw new GateServiceError(
      "GATE_PROJECT_INSTANCE_MANUAL_FORBIDDEN",
      "项目范围 Gate 实例只能在项目创建时物化。",
      409
    );
  }
  if (input.scope === "DELIVERY_UNIT" && deliveryUnitId !== null && moduleId === null) {
    return { scope: input.scope, deliveryUnitId, moduleId };
  }
  if (input.scope === "MODULE" && deliveryUnitId !== null && moduleId !== null) {
    return { scope: input.scope, deliveryUnitId, moduleId };
  }
  throw new GateServiceError(
    "GATE_SCOPE_TARGET_INVALID",
    "Gate 范围与交付单元/模块目标不匹配。",
    422
  );
}

export function resolveGateStageStatus(input: {
  scope: GateScopeCode;
  projectStageStatus: ProjectStageExecutionStatus;
  deliveryUnitStageStatus: ProjectStageExecutionStatus;
}): ProjectStageExecutionStatus {
  return input.scope === "PROJECT" ? input.projectStageStatus : input.deliveryUnitStageStatus;
}

function evidenceObject(value: unknown): JsonValue {
  const canonical = payloadHash(value).value;
  return canonical !== null && !Array.isArray(canonical) && typeof canonical === "object"
    ? canonical
    : { value: canonical };
}

function failedCheck(input: {
  position: number;
  checkerCode: string;
  checkerVersion: number;
  failureCode: string;
  message: string;
  evidence: unknown;
}): GateCheckResultFact {
  const evidence = evidenceObject(input.evidence);
  return {
    position: input.position,
    checkerCode: input.checkerCode,
    checkerVersion: input.checkerVersion,
    status: "HARD_FAILED",
    failureCode: input.failureCode,
    message: input.message,
    evidence,
    evidenceChecksum: payloadHash(evidence).hash
  };
}

export function evaluateFrozenGateCheckers(
  input: {
    projectId: string;
    gateCode: string;
    stageCode: string;
    stageStatus: ProjectStageExecutionStatus;
    scope: GateScopeCode;
    checkerBindings: readonly FrozenGateCheckerBinding[];
    checkerFacts?: Readonly<Record<string, JsonValue>>;
  },
  resolver: (code: string, version: number) => GateChecker | undefined = resolveGateChecker
): GateCheckResultFact[] {
  if (input.checkerBindings.length === 0) {
    return [
      failedCheck({
        position: 0,
        checkerCode: "GATE.BINDINGS",
        checkerVersion: 1,
        failureCode: "CHECKER_BINDINGS_EMPTY",
        message: "Gate 未冻结任何可执行检查器。",
        evidence: { gateCode: input.gateCode }
      })
    ];
  }
  return input.checkerBindings.map((binding, position) => {
    const checker = resolver(binding.code, binding.version);
    if (!checker) {
      return failedCheck({
        position,
        checkerCode: binding.code,
        checkerVersion: binding.version,
        failureCode: "CHECKER_NOT_REGISTERED",
        message: "冻结的 Gate 检查器版本未在当前服务注册。",
        evidence: { checkerCode: binding.code, checkerVersion: binding.version }
      });
    }
    if (!checker.supportedScopes.includes(input.scope)) {
      return failedCheck({
        position,
        checkerCode: binding.code,
        checkerVersion: binding.version,
        failureCode: "CHECKER_SCOPE_UNSUPPORTED",
        message: "冻结的 Gate 检查器不支持此实例范围。",
        evidence: {
          checkerCode: binding.code,
          checkerVersion: binding.version,
          scope: input.scope,
          supportedScopes: [...checker.supportedScopes]
        }
      });
    }
    try {
      const result = checker.evaluate({
        projectId: input.projectId,
        gateCode: input.gateCode,
        stageCode: input.stageCode,
        stageStatus: input.stageStatus,
        scope: input.scope,
        facts: input.checkerFacts ?? null
      });
      const evidence = evidenceObject(result.evidence);
      return {
        position,
        checkerCode: binding.code,
        checkerVersion: binding.version,
        status: result.status,
        failureCode: result.status === "HARD_FAILED" ? result.code : null,
        message: result.message,
        evidence,
        evidenceChecksum: payloadHash(evidence).hash
      };
    } catch {
      return failedCheck({
        position,
        checkerCode: binding.code,
        checkerVersion: binding.version,
        failureCode: "CHECKER_EVALUATION_FAILED",
        message: "冻结的 Gate 检查器执行失败。",
        evidence: { checkerCode: binding.code, checkerVersion: binding.version }
      });
    }
  });
}

function aggregateGateCheckStatus(results: readonly GateCheckResultFact[]): GateCheckStatus {
  if (results.some((result) => result.status === "HARD_FAILED")) return "HARD_FAILED";
  if (results.some((result) => result.status === "WARNING")) return "WARNING";
  return "PASSED";
}

export function buildGateCheckRun(input: {
  projectId: string;
  instanceId: string;
  definition: {
    code: string;
    name: string;
    projectStageId: string;
    definitionJson: unknown;
  };
  scope: GateScopeTarget;
  stage: { code: string; status: ProjectStageExecutionStatus };
  checkerBindings: readonly FrozenGateCheckerBinding[];
  checkerFacts?: Readonly<Record<string, JsonValue>>;
  reason: string;
}) {
  const definitionSnapshot = payloadHash({
    code: input.definition.code,
    name: input.definition.name,
    projectStageId: input.definition.projectStageId,
    definitionJson: input.definition.definitionJson
  }).value;
  const scopeSnapshot = payloadHash({
    projectId: input.projectId,
    gateInstanceId: input.instanceId,
    scope: input.scope.scope,
    deliveryUnitId: input.scope.deliveryUnitId,
    moduleId: input.scope.moduleId
  }).value;
  const checkerBindings = payloadHash(input.checkerBindings).value;
  const checkerFacts = payloadHash(input.checkerFacts ?? {}).value;
  const results = evaluateFrozenGateCheckers({
    projectId: input.projectId,
    gateCode: input.definition.code,
    stageCode: input.stage.code,
    stageStatus: input.stage.status,
    scope: input.scope.scope,
    checkerBindings: input.checkerBindings,
    checkerFacts: checkerFacts as Readonly<Record<string, JsonValue>>
  });
  const inputChecksum = payloadHash({
    definitionSnapshot,
    scopeSnapshot,
    checkerBindings,
    checkerFacts,
    stage: input.stage,
    reason: input.reason
  }).hash;
  const resultChecksum = payloadHash(
    results.map(({ evidenceChecksum, ...result }) => ({ ...result, evidenceChecksum }))
  ).hash;
  return {
    definitionSnapshot,
    scopeSnapshot,
    checkerBindings,
    checkerFacts,
    results,
    overallStatus: aggregateGateCheckStatus(results),
    inputChecksum,
    resultChecksum
  };
}

function needsProcurementFacts(bindings: readonly FrozenGateCheckerBinding[]) {
  return bindings.some(
    (binding) => binding.code === "PROCUREMENT.READINESS" && binding.version === 1
  );
}

async function freezeProcurementCheckerFacts(input: {
  projectId: string;
  scope: GateScopeTarget;
  gateThreshold?: JsonValue;
}): Promise<Readonly<Record<string, JsonValue>>> {
  const gateFacts = await readProcurementGateFacts({ projectId: input.projectId });
  const scopeId =
    input.scope.scope === "PROJECT"
      ? input.projectId
      : input.scope.scope === "DELIVERY_UNIT"
        ? input.scope.deliveryUnitId
        : input.scope.moduleId;
  const scopeType =
    input.scope.scope === "PROJECT"
      ? "PROJECT"
      : input.scope.scope === "DELIVERY_UNIT"
        ? "DELIVERY_UNIT"
        : "MODULE";
  const readiness = gateFacts.scopes.find(
    (fact) => fact.scopeType === scopeType && fact.scopeId === scopeId
  );
  const affectedRequirementIds = gateFacts.scopes
    .filter((fact) => fact.scopeType === "REQUIREMENT" && fact.status !== "READY")
    .map((fact) => fact.scopeId)
    .sort((left, right) => left.localeCompare(right));
  return {
    procurementReadiness: {
      readinessResultId: readiness?.id ?? null,
      policyVersion: readiness?.policyVersionId ?? gateFacts.policyVersion,
      formulaVersion: readiness?.formulaVersion ?? gateFacts.formulaVersion,
      inputWatermark: readiness?.inputWatermark ?? gateFacts.inputWatermark,
      calculatedAt: readiness?.calculatedAt ?? gateFacts.calculatedAt,
      status: readiness?.status ?? "NOT_CALCULATED",
      criticalGapLines: readiness?.blockingCriticalLines ?? gateFacts.criticalGapLines,
      gapLines: readiness?.gapLines ?? gateFacts.gapLines,
      affectedRequirementIds,
      wrongDrawingVersionRequirementIds: [...gateFacts.wrongDrawingVersionRequirementIds],
      unresolvedMajorChangeRequirementIds: [...gateFacts.unresolvedMajorChangeRequirementIds],
      changeFactsAvailability: gateFacts.changeFactsAvailability,
      gateThreshold: input.gateThreshold ?? frozenGateThreshold(gateFacts.gateThreshold) ?? null
    }
  };
}

function frozenGateThreshold(value: unknown): JsonValue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const nested = record.gateThreshold ?? record.procurementGateThreshold;
  if (nested !== undefined) return frozenGateThreshold(nested);
  const warningGapLines = record.warningGapLines;
  const hardFailureGapLines = record.hardFailureGapLines;
  const validThreshold = (candidate: unknown): candidate is number | null =>
    candidate === null || (Number.isSafeInteger(candidate) && (candidate as number) >= 0);
  if (!validThreshold(warningGapLines) || !validThreshold(hardFailureGapLines)) return undefined;
  return { warningGapLines, hardFailureGapLines };
}

function parseFrozenCheckerBindings(value: unknown): FrozenGateCheckerBinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const parsed = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const code = (entry as Record<string, unknown>).code;
    const version = (entry as Record<string, unknown>).version;
    if (
      typeof code !== "string" ||
      !/^[A-Z][A-Z0-9_.-]{1,99}$/u.test(code) ||
      !Number.isSafeInteger(version) ||
      (version as number) < 1
    ) {
      return [];
    }
    return [{ code, version: version as number }];
  });
  return parsed.length === value.length ? parsed : [];
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

function assertProjectWritable(project: { initializationStatus: string; status: string }) {
  if (project.initializationStatus !== "READY") {
    throw new GateServiceError("GATE_PROJECT_NOT_READY", "项目模板快照尚未准备完成。", 409);
  }
  if (project.status === "CLOSED" || project.status === "CANCELED") {
    throw new GateServiceError("GATE_PROJECT_READ_ONLY", "已关闭项目不能创建或检查 Gate。", 409);
  }
}

function auditContextFor(
  input: { actorId: string; auditContext: AuditContext },
  project: { id: string; departmentId: string | null },
  reason: string
): AuditContext {
  return {
    ...input.auditContext,
    actorId: input.actorId,
    projectId: project.id,
    departmentId: project.departmentId,
    reason
  };
}

function gateInstanceAuditValue(value: {
  id: string;
  projectId: string;
  gateDefinitionId: string;
  projectStageId: string;
  scope: string;
  deliveryUnitId: string | null;
  moduleId: string | null;
  version: number;
}) {
  return {
    projectId: value.projectId,
    gateInstanceId: value.id,
    gateDefinitionId: value.gateDefinitionId,
    projectStageId: value.projectStageId,
    scope: value.scope,
    deliveryUnitId: value.deliveryUnitId,
    moduleId: value.moduleId,
    version: value.version
  };
}

function gateSnapshotAuditValue(value: {
  id: string;
  projectId: string;
  gateInstanceId: string;
  sequence: number;
  status: string;
  inputChecksum: string;
  resultChecksum: string;
}) {
  return {
    projectId: value.projectId,
    gateInstanceId: value.gateInstanceId,
    gateCheckSnapshotId: value.id,
    sequence: value.sequence,
    status: value.status,
    inputChecksum: value.inputChecksum,
    resultChecksum: value.resultChecksum
  };
}

async function assertScopeTargetRelations(
  client: Prisma.TransactionClient,
  projectId: string,
  target: GateScopeTarget
) {
  const deliveryUnit = await client.deliveryUnit.findFirst({
    where: { id: target.deliveryUnitId ?? undefined, projectId },
    select: { id: true }
  });
  if (!deliveryUnit) {
    throw new GateServiceError("GATE_SCOPE_TARGET_INVALID", "Gate 目标不属于当前项目。", 409);
  }
  if (target.scope !== "MODULE") return;
  const projectModule = await client.projectModule.findFirst({
    where: { id: target.moduleId ?? undefined, projectId },
    select: { id: true, deliveryUnitId: true }
  });
  if (!projectModule || projectModule.deliveryUnitId !== target.deliveryUnitId) {
    throw new GateServiceError(
      "GATE_SCOPE_TARGET_INVALID",
      "模块必须归属指定的同项目交付单元。",
      409
    );
  }
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new GateServiceError("GATE_INSTANCE_CONFLICT", "Gate 实例或检查序列已存在。", 409);
    }
    if (error.code === "P2003" || error.code === "P2004") {
      throw new GateServiceError(
        "GATE_SCOPE_TARGET_INVALID",
        "Gate 对象关系未通过数据库约束。",
        409
      );
    }
  }
  throw error;
}

export async function createGateInstance(
  input: {
    projectId: string;
    gateDefinitionId: string;
    scope: GateScopeCode;
    deliveryUnitId?: string | null;
    moduleId?: string | null;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const target = validateGateInstanceScopeTarget(input);
  try {
    return await inTransaction(transaction, async (client) => {
      const project = await client.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw new GateServiceError("GATE_PROJECT_NOT_FOUND", "项目不存在。", 404);
      assertProjectWritable(project);
      const definition = await client.projectGateDefinition.findFirst({
        where: { id: input.gateDefinitionId, projectId: input.projectId }
      });
      if (!definition) {
        throw new GateServiceError("GATE_DEFINITION_NOT_FOUND", "项目 Gate 定义不存在。", 404);
      }
      if (definition.scope !== target.scope) {
        throw new GateServiceError(
          "GATE_SCOPE_TARGET_INVALID",
          "Gate 实例范围必须匹配冻结定义。",
          422
        );
      }
      await assertScopeTargetRelations(client, input.projectId, target);
      const instance = await client.projectGateInstance.create({
        data: {
          projectId: input.projectId,
          gateDefinitionId: definition.id,
          projectStageId: definition.projectStageId,
          scope: target.scope as GateScope,
          deliveryUnitId: target.deliveryUnitId,
          moduleId: target.moduleId,
          createdById: input.actorId,
          updatedById: input.actorId
        }
      });
      const auditValue = gateInstanceAuditValue(instance);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.GATE_INSTANCE_CREATED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_GATE_INSTANCE,
        objectId: instance.id,
        context: auditContextFor(input, project, "创建范围 Gate 实例"),
        after: { value: auditValue, allowedFields: PROJECT_GATE_INSTANCE_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "gate.instance.created",
        aggregateType: "PROJECT_GATE_INSTANCE",
        aggregateId: instance.id,
        idempotencyKey: `${instance.id}:created`,
        payload: auditValue
      });
      return {
        gateInstance: instance,
        resourceVersion: instance.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    if (error instanceof GateServiceError) throw error;
    mapDatabaseError(error);
  }
}

export async function listProjectGates(projectId: string) {
  const definitions = await db.projectGateDefinition.findMany({
    where: { projectId },
    orderBy: { code: "asc" },
    include: {
      instances: {
        orderBy: { createdAt: "asc" },
        include: {
          checkSnapshots: {
            orderBy: { sequence: "desc" },
            include: { results: { orderBy: { position: "asc" } } }
          }
        }
      }
    }
  });
  return { definitions };
}

export async function runGateChecks(
  input: {
    projectId: string;
    gateInstanceId: string;
    version: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const version = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const instance = await client.projectGateInstance.findFirst({
        where: { id: input.gateInstanceId, projectId: input.projectId },
        include: { gateDefinition: true, projectStage: true }
      });
      if (!instance) {
        throw new GateServiceError("GATE_INSTANCE_NOT_FOUND", "项目 Gate 实例不存在。", 404);
      }
      const project = await client.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw new GateServiceError("GATE_PROJECT_NOT_FOUND", "项目不存在。", 404);
      assertProjectWritable(project);
      const deliveryUnitStage =
        instance.scope === "PROJECT"
          ? null
          : await client.deliveryUnitStage.findFirst({
              where: {
                projectId: input.projectId,
                deliveryUnitId: instance.deliveryUnitId ?? undefined,
                projectStageId: instance.projectStageId
              },
              select: { status: true }
            });
      if (instance.scope !== "PROJECT" && !deliveryUnitStage) {
        throw new GateServiceError(
          "GATE_DELIVERY_UNIT_STAGE_NOT_FOUND",
          "Gate 目标缺少对应的交付单元阶段事实。",
          409
        );
      }
      const stageStatus = resolveGateStageStatus({
        scope: instance.scope as GateScopeCode,
        projectStageStatus: instance.projectStage.status,
        deliveryUnitStageStatus: deliveryUnitStage?.status ?? instance.projectStage.status
      });
      if (stageStatus !== "AWAITING_GATE") {
        throw new GateServiceError(
          "GATE_STAGE_NOT_AWAITING",
          "关联阶段尚未进入等待 Gate 检查状态。",
          409
        );
      }
      const checkerBindings = parseFrozenCheckerBindings(
        instance.gateDefinition.checkerBindingsJson
      );
      const checkerFacts = needsProcurementFacts(checkerBindings)
        ? await freezeProcurementCheckerFacts({
            projectId: input.projectId,
            scope: {
              scope: instance.scope as GateScopeCode,
              deliveryUnitId: instance.deliveryUnitId,
              moduleId: instance.moduleId
            },
            gateThreshold: frozenGateThreshold(instance.gateDefinition.definitionJson)
          })
        : {};
      const run = buildGateCheckRun({
        projectId: input.projectId,
        instanceId: instance.id,
        definition: {
          code: instance.gateDefinition.code,
          name: instance.gateDefinition.name,
          projectStageId: instance.gateDefinition.projectStageId,
          definitionJson: instance.gateDefinition.definitionJson
        },
        scope: {
          scope: instance.scope as GateScopeCode,
          deliveryUnitId: instance.deliveryUnitId,
          moduleId: instance.moduleId
        },
        stage: { code: instance.projectStage.code, status: stageStatus },
        checkerBindings,
        checkerFacts,
        reason
      });
      const updated = await client.projectGateInstance.updateMany({
        where: {
          id: instance.id,
          projectId: input.projectId,
          version,
          checkRunSequence: instance.checkRunSequence
        },
        data: {
          checkRunSequence: { increment: 1 },
          version: { increment: 1 },
          updatedById: input.actorId
        }
      });
      if (updated.count !== 1) {
        throw new GateServiceError("GATE_VERSION_CONFLICT", "Gate 实例已变化，请刷新后重试。", 409);
      }
      const checkedAt = await databaseNow(client);
      const snapshot = await client.gateCheckSnapshot.create({
        data: {
          projectId: input.projectId,
          gateInstanceId: instance.id,
          sequence: instance.checkRunSequence + 1,
          status: run.overallStatus,
          definitionSnapshot: run.definitionSnapshot as Prisma.InputJsonValue,
          scopeSnapshot: run.scopeSnapshot as Prisma.InputJsonValue,
          checkerBindingsJson: run.checkerBindings as Prisma.InputJsonValue,
          reason,
          inputChecksum: run.inputChecksum,
          resultChecksum: run.resultChecksum,
          checkedById: input.actorId,
          checkedAt
        }
      });
      await client.gateCheckResult.createMany({
        data: run.results.map((result) => ({
          projectId: input.projectId,
          gateCheckSnapshotId: snapshot.id,
          position: result.position,
          checkerCode: result.checkerCode,
          checkerVersion: result.checkerVersion,
          status: result.status,
          failureCode: result.failureCode,
          message: result.message,
          evidenceJson: result.evidence as Prisma.InputJsonValue,
          evidenceChecksum: result.evidenceChecksum
        }))
      });
      const gateInstance = await client.projectGateInstance.findUniqueOrThrow({
        where: { id: instance.id }
      });
      const auditValue = gateSnapshotAuditValue(snapshot);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.GATE_CHECK_RUN_COMPLETED,
        objectType: AUDIT_OBJECT_TYPES.GATE_CHECK_SNAPSHOT,
        objectId: snapshot.id,
        context: auditContextFor(input, project, reason),
        after: { value: auditValue, allowedFields: GATE_CHECK_SNAPSHOT_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "gate.check-run.completed",
        aggregateType: "GATE_CHECK_SNAPSHOT",
        aggregateId: snapshot.id,
        idempotencyKey: `${instance.id}:check:${snapshot.sequence}`,
        payload: auditValue
      });
      return {
        gateCheckSnapshot: snapshot,
        results: run.results,
        resourceVersion: gateInstance.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    if (error instanceof GateServiceError) throw error;
    mapDatabaseError(error);
  }
}
