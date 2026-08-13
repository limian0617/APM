import { Prisma } from "@prisma/client";

import { inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  PROJECT_GATE_DEFINITION_AUDIT_FIELDS,
  PROJECT_GATE_INSTANCE_AUDIT_FIELDS,
  PROJECT_CLOSURE_POLICY_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import { assertProjectWritable } from "@/modules/projects/domain/project-write-policy";

import {
  CLOSURE_POLICY_BINDINGS,
  ClosurePolicyError,
  buildClosurePolicyVersionFacts
} from "../domain/project-closure-policy";
import { payloadHash } from "../domain/idempotency";

type SourceInput = {
  projectId: string;
  sourceTemplateSnapshotId: string;
  sourceGateDefinitionId: string;
  gateInstanceId: string;
  actorId: string;
  auditContext: AuditContext;
};

const POLICY_ACTIVATED_EVENT = "project.closure-policy.version.activated";
const POLICY_GATE_REVISION_EVENT = "project.closure-policy.g9-revision.materialized";

type ClosureGateDefinition = {
  id: string;
  projectId: string;
  sourceSnapshotComponentId: string;
  projectStageId: string;
  revision: number;
  code: string;
  name: string;
  scope: string;
  definitionJson: Prisma.JsonValue;
  definitionChecksum: string;
  checkerBindingsJson: Prisma.JsonValue;
  instances: Array<{ id: string }>;
};

type ResolvedPolicySource = {
  input: SourceInput;
  facts: ReturnType<typeof buildClosurePolicyVersionFacts>;
};

function text(value: string, field: string, max = 191) {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new ClosurePolicyError("CLOSURE_POLICY_INPUT_INVALID", `${field} 无效。`, 422);
  }
  return normalized;
}

function bindings(value: Prisma.JsonValue): Array<{ code: string; version: number }> {
  if (!Array.isArray(value)) {
    throw new ClosurePolicyError("CLOSURE_POLICY_BINDINGS_INVALID", "G9 检查器绑定无效。");
  }
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.code !== "string" ||
      typeof item.version !== "number"
    ) {
      throw new ClosurePolicyError("CLOSURE_POLICY_BINDINGS_INVALID", "G9 检查器绑定无效。");
    }
    return { code: item.code, version: item.version };
  });
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

function factsForSource(input: SourceInput, checkerBindings: Prisma.JsonValue) {
  return buildClosurePolicyVersionFacts({
    projectId: input.projectId,
    sourceTemplateSnapshotId: input.sourceTemplateSnapshotId,
    sourceGateDefinitionId: input.sourceGateDefinitionId,
    checkerBindings: bindings(checkerBindings)
  });
}

async function readSourceDefinition(client: Prisma.TransactionClient, input: SourceInput) {
  const [project, snapshot, definition] = await Promise.all([
    client.project.findUnique({ where: { id: input.projectId } }),
    client.projectTemplateSnapshot.findFirst({
      where: { id: input.sourceTemplateSnapshotId, projectId: input.projectId },
      select: { id: true, projectId: true }
    }),
    client.projectGateDefinition.findFirst({
      where: { id: input.sourceGateDefinitionId, projectId: input.projectId },
      include: { instances: { where: { id: input.gateInstanceId, projectId: input.projectId } } }
    })
  ]);
  if (!project) throw new ClosurePolicyError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  assertProjectWritable(project.status);
  if (!snapshot || !definition || definition.instances.length !== 1) {
    throw new ClosurePolicyError(
      "CLOSURE_POLICY_SOURCE_INVALID",
      "关项策略来源快照、G9 定义或实例不属于当前项目。"
    );
  }
  if (definition.code !== "G9" || definition.scope !== "PROJECT") {
    throw new ClosurePolicyError("CLOSURE_POLICY_SOURCE_INVALID", "关项策略必须引用项目级 G9。");
  }
  return {
    snapshotId: snapshot.id,
    definition: definition as ClosureGateDefinition
  };
}

async function resolvePolicySource(client: Prisma.TransactionClient, input: SourceInput) {
  const source = await readSourceDefinition(client, input);
  return {
    input: { ...input, sourceTemplateSnapshotId: source.snapshotId },
    facts: factsForSource(input, source.definition.checkerBindingsJson)
  } satisfies ResolvedPolicySource;
}

async function materializeV2GateRevision(
  client: Prisma.TransactionClient,
  input: SourceInput & { idempotencyKey: string },
  definition: ClosureGateDefinition
) {
  const latest = await client.projectGateDefinition.findFirst({
    where: { projectId: input.projectId, code: "G9" },
    orderBy: { revision: "desc" },
    select: { revision: true }
  });
  const revision = (latest?.revision ?? definition.revision) + 1;
  const sourceDefinition =
    definition.definitionJson && typeof definition.definitionJson === "object"
      ? (definition.definitionJson as Record<string, Prisma.JsonValue>)
      : {};
  const v2DefinitionJson = {
    ...sourceDefinition,
    scope: "PROJECT",
    checkers: [...CLOSURE_POLICY_BINDINGS]
  } as Prisma.InputJsonValue;
  const v2Definition = await client.projectGateDefinition.create({
    data: {
      projectId: input.projectId,
      sourceSnapshotComponentId: definition.sourceSnapshotComponentId,
      projectStageId: definition.projectStageId,
      revision,
      code: "G9",
      name: definition.name,
      scope: "PROJECT",
      definitionJson: v2DefinitionJson,
      checkerBindingsJson: payloadHash(CLOSURE_POLICY_BINDINGS).value as Prisma.InputJsonValue,
      definitionChecksum: payloadHash(v2DefinitionJson).hash,
      materializedById: input.actorId
    }
  });
  const v2Instance = await client.projectGateInstance.create({
    data: {
      projectId: input.projectId,
      gateDefinitionId: v2Definition.id,
      projectStageId: definition.projectStageId,
      scope: "PROJECT",
      createdById: input.actorId,
      updatedById: input.actorId
    }
  });
  const context = {
    ...input.auditContext,
    actorId: input.actorId,
    projectId: input.projectId
  };
  await writeAudit(client, {
    action: AUDIT_ACTIONS.GATE_DEFINITION_MATERIALIZED,
    objectType: AUDIT_OBJECT_TYPES.PROJECT_GATE_DEFINITION,
    objectId: v2Definition.id,
    context,
    after: {
      value: {
        projectId: input.projectId,
        gateDefinitionId: v2Definition.id,
        sourceGateDefinitionId: definition.id,
        code: "G9",
        revision,
        checkerBindings: CLOSURE_POLICY_BINDINGS
      },
      allowedFields: PROJECT_GATE_DEFINITION_AUDIT_FIELDS
    }
  });
  await writeAudit(client, {
    action: AUDIT_ACTIONS.GATE_INSTANCE_CREATED,
    objectType: AUDIT_OBJECT_TYPES.PROJECT_GATE_INSTANCE,
    objectId: v2Instance.id,
    context,
    after: {
      value: {
        projectId: input.projectId,
        gateDefinitionId: v2Definition.id,
        gateInstanceId: v2Instance.id,
        sourceGateDefinitionId: definition.id,
        revision
      },
      allowedFields: PROJECT_GATE_INSTANCE_AUDIT_FIELDS
    }
  });
  await appendOutboxEvent(client, {
    eventType: POLICY_GATE_REVISION_EVENT,
    aggregateType: "PROJECT_GATE_DEFINITION",
    aggregateId: v2Definition.id,
    idempotencyKey: `${input.idempotencyKey}:closure-policy:g9-v2`,
    payload: {
      projectId: input.projectId,
      sourceGateDefinitionId: definition.id,
      gateDefinitionId: v2Definition.id,
      gateInstanceId: v2Instance.id,
      revision,
      checkerBindings: CLOSURE_POLICY_BINDINGS
    }
  });
  return {
    sourceGateDefinitionId: v2Definition.id,
    gateInstanceId: v2Instance.id
  };
}

async function resolveUpgradeSource(
  client: Prisma.TransactionClient,
  input: SourceInput & { idempotencyKey: string }
) {
  const source = await readSourceDefinition(client, input);
  const resolvedInput = { ...input, sourceTemplateSnapshotId: source.snapshotId };
  const upgraded = await materializeV2GateRevision(client, resolvedInput, source.definition);
  const upgradedInput = { ...resolvedInput, ...upgraded };
  return {
    input: upgradedInput,
    facts: buildClosurePolicyVersionFacts({
      projectId: upgradedInput.projectId,
      sourceTemplateSnapshotId: upgradedInput.sourceTemplateSnapshotId,
      sourceGateDefinitionId: upgradedInput.sourceGateDefinitionId,
      checkerBindings: CLOSURE_POLICY_BINDINGS
    })
  } satisfies ResolvedPolicySource;
}

async function writePolicyFacts(
  client: Prisma.TransactionClient,
  input: SourceInput & {
    policyVersionId: string;
    policyId: string;
    policyChecksum: string;
    bindingChecksum: string;
    idempotencyKey: string;
    reason: string | null;
    requestedSourceGateDefinitionId?: string;
    requestedGateInstanceId?: string;
  }
) {
  const payload = {
    projectId: input.projectId,
    closurePolicyVersionId: input.policyVersionId,
    closurePolicyId: input.policyId,
    sourceTemplateSnapshotId: input.sourceTemplateSnapshotId,
    sourceGateDefinitionId: input.sourceGateDefinitionId,
    gateInstanceId: input.gateInstanceId,
    archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
    bindingChecksum: input.bindingChecksum,
    policyChecksum: input.policyChecksum,
    actorId: input.actorId,
    operationReason: input.reason,
    ...(input.requestedSourceGateDefinitionId === undefined
      ? {}
      : {
          requestedSourceGateDefinitionId: input.requestedSourceGateDefinitionId,
          requestedGateInstanceId: input.requestedGateInstanceId
        })
  };
  const audit = await writeAudit(client, {
    action: AUDIT_ACTIONS.PROJECT_CLOSURE_POLICY_UPGRADED,
    objectType: AUDIT_OBJECT_TYPES.PROJECT_CLOSURE_POLICY_VERSION,
    objectId: input.policyVersionId,
    context: {
      ...input.auditContext,
      actorId: input.actorId,
      projectId: input.projectId,
      reason: input.reason
    },
    after: { value: payload, allowedFields: PROJECT_CLOSURE_POLICY_AUDIT_FIELDS }
  });
  const outbox = await appendOutboxEvent(client, {
    eventType: POLICY_ACTIVATED_EVENT,
    aggregateType: "PROJECT_CLOSURE_POLICY_VERSION",
    aggregateId: input.policyVersionId,
    idempotencyKey: input.idempotencyKey,
    payload: { ...payload, auditId: audit.id }
  });
  return { auditId: audit.id, outboxEventId: outbox.id };
}

function replayPayload(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClosurePolicyError("IDEMPOTENCY_KEY_REUSED", "幂等键对应的关项策略事实无效。", 409);
  }
  return value as Record<string, Prisma.JsonValue>;
}

async function replayUpgrade(
  client: Prisma.TransactionClient,
  input: SourceInput & { idempotencyKey: string; reason: string }
) {
  const event = await client.outboxEvent.findUnique({
    where: {
      eventType_idempotencyKey: {
        eventType: POLICY_ACTIVATED_EVENT,
        idempotencyKey: input.idempotencyKey
      }
    }
  });
  if (!event) return null;
  const payload = replayPayload(event.payload);
  const expected = {
    projectId: input.projectId,
    sourceTemplateSnapshotId: input.sourceTemplateSnapshotId,
    actorId: input.actorId,
    operationReason: input.reason
  };
  if (Object.entries(expected).some(([field, value]) => payload[field] !== value)) {
    throw new ClosurePolicyError(
      "IDEMPOTENCY_KEY_REUSED",
      "相同幂等键已绑定到不同的关项策略升级。",
      409
    );
  }
  if (
    typeof payload.closurePolicyId !== "string" ||
    typeof payload.closurePolicyVersionId !== "string" ||
    typeof payload.auditId !== "string" ||
    typeof payload.sourceGateDefinitionId !== "string" ||
    typeof payload.gateInstanceId !== "string"
  ) {
    throw new ClosurePolicyError("IDEMPOTENCY_KEY_REUSED", "幂等键对应的关项策略事实不完整。", 409);
  }
  const requestedDefinitionId =
    typeof payload.requestedSourceGateDefinitionId === "string"
      ? payload.requestedSourceGateDefinitionId
      : payload.sourceGateDefinitionId;
  const requestedInstanceId =
    typeof payload.requestedGateInstanceId === "string"
      ? payload.requestedGateInstanceId
      : payload.gateInstanceId;
  if (
    requestedDefinitionId !== input.sourceGateDefinitionId ||
    requestedInstanceId !== input.gateInstanceId
  ) {
    throw new ClosurePolicyError(
      "IDEMPOTENCY_KEY_REUSED",
      "相同幂等键已绑定到不同的关项策略升级。",
      409
    );
  }
  const facts = buildClosurePolicyVersionFacts({
    projectId: input.projectId,
    sourceTemplateSnapshotId: input.sourceTemplateSnapshotId,
    sourceGateDefinitionId: payload.sourceGateDefinitionId,
    checkerBindings: CLOSURE_POLICY_BINDINGS
  });
  if (
    payload.archiveSourceFormulaVersion !== facts.archiveSourceFormulaVersion ||
    payload.bindingChecksum !== facts.bindingChecksum ||
    payload.policyChecksum !== facts.policyChecksum
  ) {
    throw new ClosurePolicyError("IDEMPOTENCY_KEY_REUSED", "幂等键对应的关项策略事实不完整。", 409);
  }
  return {
    policyId: payload.closurePolicyId,
    policyVersionId: payload.closurePolicyVersionId,
    ...facts,
    auditId: payload.auditId,
    outboxEventId: event.id,
    replayed: true as const
  };
}

export async function materializeInitialProjectClosurePolicy(
  client: Prisma.TransactionClient,
  input: SourceInput
) {
  const source = await resolvePolicySource(client, input);
  const facts = source.facts;
  const policy = await client.projectClosurePolicy.create({
    data: {
      projectId: input.projectId,
      status: "ACTIVE",
      createdById: input.actorId,
      updatedById: input.actorId
    }
  });
  const effectiveAt = await databaseNow(client);
  const version = await client.projectClosurePolicyVersion.create({
    data: {
      projectId: input.projectId,
      policyId: policy.id,
      versionNo: 1,
      status: "ACTIVE",
      sourceTemplateSnapshotId: facts.sourceTemplateSnapshotId,
      sourceGateDefinitionId: facts.sourceGateDefinitionId,
      archiveCheckerCode: facts.archiveCheckerCode,
      archiveCheckerVersion: facts.archiveCheckerVersion,
      retrospectiveCheckerCode: facts.retrospectiveCheckerCode,
      retrospectiveCheckerVersion: facts.retrospectiveCheckerVersion,
      archiveSourceFormulaVersion: "V2",
      selfReferenceExclusionVersion: facts.selfReferenceExclusionVersion,
      bindingChecksum: facts.bindingChecksum,
      policyChecksum: facts.policyChecksum,
      effectiveAt,
      createdById: input.actorId
    }
  });
  const [aggregate, instance] = await Promise.all([
    client.projectClosurePolicy.updateMany({
      where: { id: policy.id, projectId: input.projectId, version: policy.version },
      data: { currentVersionId: version.id, version: { increment: 1 }, updatedById: input.actorId }
    }),
    client.projectGateInstance.updateMany({
      where: {
        id: input.gateInstanceId,
        projectId: input.projectId,
        gateDefinitionId: input.sourceGateDefinitionId,
        closurePolicyVersionId: null
      },
      data: {
        closurePolicyVersionId: version.id,
        archiveSourceFormulaVersion: "V2",
        closurePolicyChecksum: facts.policyChecksum,
        version: { increment: 1 },
        updatedById: input.actorId
      }
    })
  ]);
  if (aggregate.count !== 1 || instance.count !== 1) {
    throw new ClosurePolicyError("CLOSURE_POLICY_VERSION_CONFLICT", "关项策略物化发生冲突。");
  }
  const evidence = await writePolicyFacts(client, {
    ...source.input,
    policyVersionId: version.id,
    policyId: policy.id,
    policyChecksum: facts.policyChecksum,
    bindingChecksum: facts.bindingChecksum,
    idempotencyKey: `${input.projectId}:closure-policy:v1`,
    reason: null
  });
  return { policyId: policy.id, policyVersionId: version.id, ...facts, ...evidence };
}

export async function upgradeProjectClosurePolicy(
  input: SourceInput & {
    expectedPolicyVersion: number;
    reason: string;
    idempotencyKey: string;
  },
  transaction?: Prisma.TransactionClient
) {
  try {
    return await inTransaction(transaction, async (client) => {
      const reason = text(input.reason, "reason", 1024);
      const replayed = await replayUpgrade(client, { ...input, reason });
      if (replayed) return replayed;
      const source = await resolveUpgradeSource(client, input);
      const facts = source.facts;
      let policy = await client.projectClosurePolicy.findUnique({
        where: { projectId: input.projectId },
        include: { currentVersion: true }
      });
      const createsInitialPolicy = !policy && input.expectedPolicyVersion === 0;
      if (createsInitialPolicy) {
        policy = {
          ...(await client.projectClosurePolicy.create({
            data: {
              projectId: input.projectId,
              status: "ACTIVE",
              createdById: input.actorId,
              updatedById: input.actorId
            }
          })),
          currentVersion: null
        };
      }
      if (!policy || policy.version !== Math.max(input.expectedPolicyVersion, 1)) {
        throw new ClosurePolicyError("CLOSURE_POLICY_VERSION_CONFLICT", "关项策略已发生变化。");
      }
      const nextVersionNo = createsInitialPolicy
        ? 1
        : ((
            await client.projectClosurePolicyVersion.findFirst({
              where: { policyId: policy.id, projectId: input.projectId },
              orderBy: { versionNo: "desc" },
              select: { versionNo: true }
            })
          )?.versionNo ?? 0) + 1;
      if (policy.currentVersion) {
        const superseded = await client.projectClosurePolicyVersion.updateMany({
          where: { id: policy.currentVersion.id, projectId: input.projectId, status: "ACTIVE" },
          data: { status: "SUPERSEDED" }
        });
        if (superseded.count !== 1) {
          throw new ClosurePolicyError("CLOSURE_POLICY_VERSION_CONFLICT", "当前策略版本已变化。");
        }
      }
      const version = await client.projectClosurePolicyVersion.create({
        data: {
          projectId: input.projectId,
          policyId: policy.id,
          versionNo: nextVersionNo,
          status: "ACTIVE",
          sourceTemplateSnapshotId: source.input.sourceTemplateSnapshotId,
          sourceGateDefinitionId: source.input.sourceGateDefinitionId,
          archiveCheckerCode: facts.archiveCheckerCode,
          archiveCheckerVersion: facts.archiveCheckerVersion,
          retrospectiveCheckerCode: facts.retrospectiveCheckerCode,
          retrospectiveCheckerVersion: facts.retrospectiveCheckerVersion,
          archiveSourceFormulaVersion: "V2",
          selfReferenceExclusionVersion: facts.selfReferenceExclusionVersion,
          bindingChecksum: facts.bindingChecksum,
          policyChecksum: facts.policyChecksum,
          upgradeReason: reason,
          effectiveAt: await databaseNow(client),
          createdById: input.actorId
        }
      });
      const aggregate = await client.projectClosurePolicy.updateMany({
        where: { id: policy.id, projectId: input.projectId, version: policy.version },
        data: {
          currentVersionId: version.id,
          version: { increment: 1 },
          updatedById: input.actorId
        }
      });
      const instance = await client.projectGateInstance.updateMany({
        where: {
          id: source.input.gateInstanceId,
          projectId: input.projectId,
          gateDefinitionId: source.input.sourceGateDefinitionId,
          closurePolicyVersionId: null
        },
        data: {
          closurePolicyVersionId: version.id,
          archiveSourceFormulaVersion: "V2",
          closurePolicyChecksum: facts.policyChecksum,
          version: { increment: 1 },
          updatedById: input.actorId
        }
      });
      if (aggregate.count !== 1 || instance.count !== 1) {
        throw new ClosurePolicyError("CLOSURE_POLICY_VERSION_CONFLICT", "关项策略升级发生冲突。");
      }
      const evidence = await writePolicyFacts(client, {
        ...source.input,
        idempotencyKey: input.idempotencyKey,
        policyVersionId: version.id,
        policyId: policy.id,
        policyChecksum: facts.policyChecksum,
        bindingChecksum: facts.bindingChecksum,
        reason,
        requestedSourceGateDefinitionId: input.sourceGateDefinitionId,
        requestedGateInstanceId: input.gateInstanceId
      });
      return { policyId: policy.id, policyVersionId: version.id, ...facts, ...evidence };
    });
  } catch (error) {
    if (error instanceof ClosurePolicyError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ClosurePolicyError("CLOSURE_POLICY_VERSION_CONFLICT", "关项策略已发生变化。", 409);
    }
    throw error;
  }
}
