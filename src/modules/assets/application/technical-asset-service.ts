import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  RND_PROJECT_AUDIT_FIELDS,
  TECHNICAL_ASSET_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  TechnicalAssetError,
  assertIndependentValidator,
  assertRndProjectTransition,
  assertTechnicalAssetTransition,
  nextTechnicalAssetStatusForValidation,
  validatePositiveVersion,
  validateReason,
  validateRndProjectCode,
  validateTechnicalAssetDescription,
  validateTechnicalAssetName,
  validateTechnicalAssetNumber,
  type RndProjectStatus,
  type TechnicalAssetStatus,
  type TechnicalAssetType,
  type TechnicalAssetValidationDecision
} from "../domain/technical-asset";

type Transaction = Prisma.TransactionClient;

function serializeRndProject(project: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  departmentId: string | null;
  ownerId: string;
  status: string;
  version: number;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: project.id,
    code: project.code,
    name: project.name,
    description: project.description,
    departmentId: project.departmentId,
    ownerId: project.ownerId,
    status: project.status,
    version: project.version,
    createdById: project.createdById,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    resourceVersion: project.version,
    allowedActions:
      project.status === "PROPOSED"
        ? ["START_DEVELOPMENT", "CANCEL"]
        : project.status === "IN_DEVELOPMENT"
          ? ["SUBMIT_VALIDATION", "CANCEL"]
          : project.status === "VALIDATION"
            ? ["RETURN_DEVELOPMENT", "SUBMIT_RELEASE_REVIEW", "CANCEL"]
            : project.status === "RELEASE_REVIEW"
              ? ["RETURN_DEVELOPMENT", "COMPLETE", "CANCEL"]
              : []
  };
}

function serializeTechnicalAsset(asset: {
  id: string;
  rndProjectId: string;
  assetNumber: string;
  assetType: string;
  name: string;
  description: string | null;
  ownerId: string;
  status: string;
  version: number;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: asset.id,
    rndProjectId: asset.rndProjectId,
    assetNumber: asset.assetNumber,
    assetType: asset.assetType,
    name: asset.name,
    description: asset.description,
    ownerId: asset.ownerId,
    status: asset.status,
    version: asset.version,
    createdById: asset.createdById,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
    resourceVersion: asset.version,
    allowedActions:
      asset.status === "DRAFT"
        ? ["SUBMIT_VALIDATION", "CANCEL"]
        : asset.status === "VALIDATION_PENDING"
          ? ["RECORD_VALIDATION", "CANCEL"]
          : []
  };
}

function rndProjectAuditValue(project: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  departmentId: string | null;
  ownerId: string;
  status: string;
  version: number;
}) {
  return {
    rndProjectId: project.id,
    rndProjectCode: project.code,
    name: project.name,
    description: project.description,
    departmentId: project.departmentId,
    ownerId: project.ownerId,
    status: project.status,
    version: project.version
  };
}

function technicalAssetAuditValue(asset: {
  id: string;
  rndProjectId: string;
  assetNumber: string;
  assetType: string;
  name: string;
  description: string | null;
  ownerId: string;
  status: string;
  version: number;
}) {
  return {
    rndProjectId: asset.rndProjectId,
    technicalAssetId: asset.id,
    assetNumber: asset.assetNumber,
    assetType: asset.assetType,
    name: asset.name,
    description: asset.description,
    ownerId: asset.ownerId,
    status: asset.status,
    version: asset.version
  };
}

function commandContext(
  context: AuditContext,
  actorId: string,
  reason: string,
  departmentId: string | null
): AuditContext {
  return { ...context, actorId, reason, departmentId, projectId: null };
}

async function databaseNow(client: Transaction): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

async function assertActiveUser(client: Transaction, userId: string, label: "Owner" | "验证人") {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { id: true, status: true }
  });
  if (!user) {
    throw new TechnicalAssetError(
      label === "Owner" ? "OWNER_NOT_FOUND" : "VALIDATOR_DISABLED",
      `${label}不存在。`,
      404
    );
  }
  if (user.status !== "ACTIVE") {
    throw new TechnicalAssetError(
      label === "Owner" ? "OWNER_DISABLED" : "VALIDATOR_DISABLED",
      `${label}必须处于启用状态。`,
      409
    );
  }
  return user;
}

async function lockRndProject(client: Transaction, rndProjectId: string) {
  await client.$queryRaw`
    SELECT "id" FROM "rnd_projects" WHERE "id" = ${rndProjectId} FOR UPDATE
  `;
  return client.rndProject.findUnique({ where: { id: rndProjectId } });
}

async function lockTechnicalAsset(client: Transaction, rndProjectId: string, assetId: string) {
  await client.$queryRaw`
    SELECT "id" FROM "technical_assets"
    WHERE "id" = ${assetId} AND "rnd_project_id" = ${rndProjectId}
    FOR UPDATE
  `;
  return client.technicalAsset.findFirst({ where: { id: assetId, rndProjectId } });
}

async function nextRndProjectEventSequence(
  client: Transaction,
  rndProjectId: string
): Promise<number> {
  const latest = await client.rndProjectEvent.findFirst({
    where: { rndProjectId },
    orderBy: { sequence: "desc" },
    select: { sequence: true }
  });
  return (latest?.sequence ?? 0) + 1;
}

async function nextTechnicalAssetEventSequence(
  client: Transaction,
  technicalAssetId: string
): Promise<number> {
  const latest = await client.technicalAssetEvent.findFirst({
    where: { technicalAssetId },
    orderBy: { sequence: "desc" },
    select: { sequence: true }
  });
  return (latest?.sequence ?? 0) + 1;
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof TechnicalAssetError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new TechnicalAssetError(
      "TECHNICAL_ASSET_NUMBER_CONFLICT",
      "研发项目代码或企业资产编号已存在。",
      409
    );
  }
  throw error;
}

function assertWritableRndProject(project: { status: string }) {
  if (project.status === "COMPLETED" || project.status === "CANCELED") {
    throw new TechnicalAssetError("RND_PROJECT_READ_ONLY", "已完成或已取消研发项目不可写入。", 409);
  }
}

function validateEvidence(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 4096) {
    throw new TechnicalAssetError("REASON_REQUIRED", "验证证据必须是 1 到 4096 个字符。", 422);
  }
  return value.trim();
}

export async function createRndProject(
  input: {
    code: unknown;
    name: unknown;
    description?: unknown;
    departmentId?: string | null;
    ownerId: string;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Transaction
) {
  const code = validateRndProjectCode(input.code);
  const name = validateTechnicalAssetName(input.name);
  const description = validateTechnicalAssetDescription(input.description);
  const reason = validateReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      await assertActiveUser(client, input.ownerId, "Owner");
      const project = await client.rndProject.create({
        data: {
          code,
          name,
          description,
          departmentId: input.departmentId ?? null,
          ownerId: input.ownerId,
          createdById: input.actorId
        }
      });
      const event = await client.rndProjectEvent.create({
        data: {
          rndProjectId: project.id,
          sequence: 1,
          eventType: "CREATED",
          toStatus: "PROPOSED",
          reason,
          snapshotJson: rndProjectAuditValue(project) as Prisma.InputJsonValue,
          actorId: input.actorId
        }
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.RND_PROJECT_CREATED,
        objectType: AUDIT_OBJECT_TYPES.RND_PROJECT,
        objectId: project.id,
        context: commandContext(input.auditContext, input.actorId, reason, project.departmentId),
        after: {
          value: {
            ...rndProjectAuditValue(project),
            eventId: event.id,
            eventSequence: event.sequence,
            reason
          },
          allowedFields: RND_PROJECT_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "rnd-project.created",
        aggregateType: "RND_PROJECT",
        aggregateId: project.id,
        idempotencyKey: `${project.id}:v${project.version}`,
        payload: rndProjectAuditValue(project)
      });
      return {
        rndProject: serializeRndProject(project),
        resourceVersion: project.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function transitionRndProject(
  input: {
    rndProjectId: string;
    version: unknown;
    toStatus: RndProjectStatus;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Transaction
) {
  const expectedVersion = validatePositiveVersion(input.version);
  const reason = validateReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const current = await lockRndProject(client, input.rndProjectId);
      if (!current) {
        throw new TechnicalAssetError("RND_PROJECT_NOT_FOUND", "内部研发项目不存在。", 404);
      }
      assertWritableRndProject(current);
      if (current.version !== expectedVersion) {
        throw new TechnicalAssetError(
          "VERSION_CONFLICT",
          "研发项目已发生变化，请刷新后重试。",
          409
        );
      }
      assertRndProjectTransition(current.status as RndProjectStatus, input.toStatus);
      const now = await databaseNow(client);
      const updated = await client.rndProject.updateMany({
        where: { id: current.id, version: expectedVersion },
        data: { status: input.toStatus, version: { increment: 1 }, updatedAt: now }
      });
      if (updated.count !== 1) {
        throw new TechnicalAssetError(
          "VERSION_CONFLICT",
          "研发项目已发生变化，请刷新后重试。",
          409
        );
      }
      const project = await client.rndProject.findUniqueOrThrow({ where: { id: current.id } });
      const event = await client.rndProjectEvent.create({
        data: {
          rndProjectId: project.id,
          sequence: await nextRndProjectEventSequence(client, project.id),
          eventType: "STATUS_CHANGED",
          fromStatus: current.status,
          toStatus: project.status,
          reason,
          snapshotJson: rndProjectAuditValue(project) as Prisma.InputJsonValue,
          actorId: input.actorId
        }
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.RND_PROJECT_STATUS_CHANGED,
        objectType: AUDIT_OBJECT_TYPES.RND_PROJECT_EVENT,
        objectId: event.id,
        context: commandContext(input.auditContext, input.actorId, reason, project.departmentId),
        before: { value: rndProjectAuditValue(current), allowedFields: RND_PROJECT_AUDIT_FIELDS },
        after: {
          value: {
            ...rndProjectAuditValue(project),
            fromStatus: current.status,
            toStatus: project.status,
            eventId: event.id,
            eventSequence: event.sequence,
            reason
          },
          allowedFields: RND_PROJECT_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "rnd-project.status-changed",
        aggregateType: "RND_PROJECT",
        aggregateId: project.id,
        idempotencyKey: `${project.id}:v${project.version}`,
        payload: {
          ...rndProjectAuditValue(project),
          fromStatus: current.status,
          toStatus: project.status
        }
      });
      return {
        rndProject: serializeRndProject(project),
        resourceVersion: project.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function createTechnicalAsset(
  input: {
    rndProjectId: string;
    assetNumber: unknown;
    assetType: TechnicalAssetType;
    name: unknown;
    description?: unknown;
    ownerId: string;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Transaction
) {
  const assetNumber = validateTechnicalAssetNumber(input.assetNumber);
  const name = validateTechnicalAssetName(input.name);
  const description = validateTechnicalAssetDescription(input.description);
  const reason = validateReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const rndProject = await lockRndProject(client, input.rndProjectId);
      if (!rndProject) {
        throw new TechnicalAssetError("RND_PROJECT_NOT_FOUND", "内部研发项目不存在。", 404);
      }
      assertWritableRndProject(rndProject);
      await assertActiveUser(client, input.ownerId, "Owner");
      const asset = await client.technicalAsset.create({
        data: {
          rndProjectId: rndProject.id,
          assetNumber,
          assetType: input.assetType,
          name,
          description,
          ownerId: input.ownerId,
          createdById: input.actorId
        }
      });
      const event = await client.technicalAssetEvent.create({
        data: {
          rndProjectId: asset.rndProjectId,
          technicalAssetId: asset.id,
          sequence: 1,
          eventType: "CREATED",
          toStatus: "DRAFT",
          reason,
          snapshotJson: technicalAssetAuditValue(asset) as Prisma.InputJsonValue,
          actorId: input.actorId
        }
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.TECHNICAL_ASSET_CREATED,
        objectType: AUDIT_OBJECT_TYPES.TECHNICAL_ASSET,
        objectId: asset.id,
        context: commandContext(input.auditContext, input.actorId, reason, rndProject.departmentId),
        after: {
          value: {
            ...technicalAssetAuditValue(asset),
            eventId: event.id,
            eventSequence: event.sequence,
            reason
          },
          allowedFields: TECHNICAL_ASSET_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "technical-asset.created",
        aggregateType: "TECHNICAL_ASSET",
        aggregateId: asset.id,
        idempotencyKey: `${asset.id}:v${asset.version}`,
        payload: technicalAssetAuditValue(asset)
      });
      return {
        asset: serializeTechnicalAsset(asset),
        resourceVersion: asset.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function getRndProject(input: { rndProjectId: string }) {
  const project = await db.rndProject.findUnique({ where: { id: input.rndProjectId } });
  if (!project) throw new TechnicalAssetError("RND_PROJECT_NOT_FOUND", "内部研发项目不存在。", 404);
  return { rndProject: serializeRndProject(project) };
}

export async function getTechnicalAsset(input: { rndProjectId: string; assetId: string }) {
  const asset = await db.technicalAsset.findFirst({
    where: { id: input.assetId, rndProjectId: input.rndProjectId }
  });
  if (!asset)
    throw new TechnicalAssetError("TECHNICAL_ASSET_NOT_FOUND", "企业技术资产不存在。", 404);
  return { asset: serializeTechnicalAsset(asset) };
}

export async function listTechnicalAssets(input: {
  rndProjectId: string;
  status?: TechnicalAssetStatus;
  cursor?: string;
  limit: number;
}) {
  const rndProject = await db.rndProject.findUnique({
    where: { id: input.rndProjectId },
    select: { id: true }
  });
  if (!rndProject) {
    throw new TechnicalAssetError("RND_PROJECT_NOT_FOUND", "内部研发项目不存在。", 404);
  }
  const rows = await db.technicalAsset.findMany({
    where: { rndProjectId: input.rndProjectId, ...(input.status ? { status: input.status } : {}) },
    orderBy: { id: "asc" },
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: input.limit + 1
  });
  const hasMore = rows.length > input.limit;
  const assets = hasMore ? rows.slice(0, input.limit) : rows;
  return {
    assets: assets.map(serializeTechnicalAsset),
    nextCursor: hasMore ? (assets.at(-1)?.id ?? null) : null
  };
}

export async function transitionTechnicalAsset(
  input: {
    rndProjectId: string;
    assetId: string;
    version: unknown;
    toStatus: TechnicalAssetStatus;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Transaction
) {
  const expectedVersion = validatePositiveVersion(input.version);
  const reason = validateReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const rndProject = await lockRndProject(client, input.rndProjectId);
      if (!rndProject) {
        throw new TechnicalAssetError("RND_PROJECT_NOT_FOUND", "内部研发项目不存在。", 404);
      }
      assertWritableRndProject(rndProject);
      const current = await lockTechnicalAsset(client, input.rndProjectId, input.assetId);
      if (!current) {
        throw new TechnicalAssetError("TECHNICAL_ASSET_NOT_FOUND", "企业技术资产不存在。", 404);
      }
      if (current.version !== expectedVersion) {
        throw new TechnicalAssetError(
          "VERSION_CONFLICT",
          "企业技术资产已发生变化，请刷新后重试。",
          409
        );
      }
      assertTechnicalAssetTransition(current.status as TechnicalAssetStatus, input.toStatus);
      if (input.toStatus === "VALIDATION_PENDING" && rndProject.status !== "VALIDATION") {
        throw new TechnicalAssetError(
          "RND_PROJECT_NOT_IN_VALIDATION",
          "只有处于验证阶段的内部研发项目可以提交资产验证。",
          409
        );
      }
      const now = await databaseNow(client);
      const updated = await client.technicalAsset.updateMany({
        where: { id: current.id, rndProjectId: input.rndProjectId, version: expectedVersion },
        data: { status: input.toStatus, version: { increment: 1 }, updatedAt: now }
      });
      if (updated.count !== 1) {
        throw new TechnicalAssetError(
          "VERSION_CONFLICT",
          "企业技术资产已发生变化，请刷新后重试。",
          409
        );
      }
      const asset = await client.technicalAsset.findUniqueOrThrow({ where: { id: current.id } });
      const event = await client.technicalAssetEvent.create({
        data: {
          rndProjectId: asset.rndProjectId,
          technicalAssetId: asset.id,
          sequence: await nextTechnicalAssetEventSequence(client, asset.id),
          eventType: "STATUS_CHANGED",
          fromStatus: current.status,
          toStatus: asset.status,
          reason,
          snapshotJson: technicalAssetAuditValue(asset) as Prisma.InputJsonValue,
          actorId: input.actorId
        }
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.TECHNICAL_ASSET_STATUS_CHANGED,
        objectType: AUDIT_OBJECT_TYPES.TECHNICAL_ASSET_EVENT,
        objectId: event.id,
        context: commandContext(input.auditContext, input.actorId, reason, rndProject.departmentId),
        before: {
          value: technicalAssetAuditValue(current),
          allowedFields: TECHNICAL_ASSET_AUDIT_FIELDS
        },
        after: {
          value: {
            ...technicalAssetAuditValue(asset),
            fromStatus: current.status,
            toStatus: asset.status,
            eventId: event.id,
            eventSequence: event.sequence,
            reason
          },
          allowedFields: TECHNICAL_ASSET_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "technical-asset.status-changed",
        aggregateType: "TECHNICAL_ASSET",
        aggregateId: asset.id,
        idempotencyKey: `${asset.id}:v${asset.version}`,
        payload: {
          ...technicalAssetAuditValue(asset),
          fromStatus: current.status,
          toStatus: asset.status
        }
      });
      return {
        asset: serializeTechnicalAsset(asset),
        resourceVersion: asset.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function recordTechnicalAssetValidation(
  input: {
    rndProjectId: string;
    assetId: string;
    version: unknown;
    decision: TechnicalAssetValidationDecision;
    evidence: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Transaction
) {
  const expectedVersion = validatePositiveVersion(input.version);
  const evidence = validateEvidence(input.evidence);
  const reason = validateReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const rndProject = await lockRndProject(client, input.rndProjectId);
      if (!rndProject) {
        throw new TechnicalAssetError("RND_PROJECT_NOT_FOUND", "内部研发项目不存在。", 404);
      }
      assertWritableRndProject(rndProject);
      const current = await lockTechnicalAsset(client, input.rndProjectId, input.assetId);
      if (!current) {
        throw new TechnicalAssetError("TECHNICAL_ASSET_NOT_FOUND", "企业技术资产不存在。", 404);
      }
      if (current.version !== expectedVersion) {
        throw new TechnicalAssetError(
          "VERSION_CONFLICT",
          "企业技术资产已发生变化，请刷新后重试。",
          409
        );
      }
      const validator = await assertActiveUser(client, input.actorId, "验证人");
      assertIndependentValidator(current.ownerId, validator.id, validator.status);
      const nextStatus = nextTechnicalAssetStatusForValidation(
        current.status as TechnicalAssetStatus,
        input.decision
      );
      const validation = await client.technicalAssetValidation.create({
        data: {
          rndProjectId: current.rndProjectId,
          technicalAssetId: current.id,
          assetVersion: current.version,
          decision: input.decision,
          evidence,
          reason,
          validatorId: validator.id
        }
      });
      const now = await databaseNow(client);
      const updated = await client.technicalAsset.updateMany({
        where: { id: current.id, rndProjectId: input.rndProjectId, version: expectedVersion },
        data: { status: nextStatus, version: { increment: 1 }, updatedAt: now }
      });
      if (updated.count !== 1) {
        throw new TechnicalAssetError(
          "VERSION_CONFLICT",
          "企业技术资产已发生变化，请刷新后重试。",
          409
        );
      }
      const asset = await client.technicalAsset.findUniqueOrThrow({ where: { id: current.id } });
      const event = await client.technicalAssetEvent.create({
        data: {
          rndProjectId: asset.rndProjectId,
          technicalAssetId: asset.id,
          sequence: await nextTechnicalAssetEventSequence(client, asset.id),
          eventType: input.decision === "PASSED" ? "VALIDATED" : "STATUS_CHANGED",
          fromStatus: current.status,
          toStatus: asset.status,
          reason,
          snapshotJson: {
            ...technicalAssetAuditValue(asset),
            validationId: validation.id,
            validationDecision: validation.decision,
            validatorId: validation.validatorId,
            evidence,
            assetVersion: validation.assetVersion
          } as Prisma.InputJsonValue,
          actorId: input.actorId
        }
      });
      const action =
        input.decision === "PASSED"
          ? AUDIT_ACTIONS.TECHNICAL_ASSET_VALIDATED
          : AUDIT_ACTIONS.TECHNICAL_ASSET_STATUS_CHANGED;
      const audit = await writeAudit(client, {
        action,
        objectType: AUDIT_OBJECT_TYPES.TECHNICAL_ASSET_VALIDATION,
        objectId: validation.id,
        context: commandContext(input.auditContext, input.actorId, reason, rndProject.departmentId),
        before: {
          value: technicalAssetAuditValue(current),
          allowedFields: TECHNICAL_ASSET_AUDIT_FIELDS
        },
        after: {
          value: {
            ...technicalAssetAuditValue(asset),
            fromStatus: current.status,
            toStatus: asset.status,
            eventId: event.id,
            eventSequence: event.sequence,
            validationId: validation.id,
            validationDecision: validation.decision,
            validatorId: validation.validatorId,
            evidence,
            assetVersion: validation.assetVersion,
            reason
          },
          allowedFields: TECHNICAL_ASSET_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType:
          input.decision === "PASSED"
            ? "technical-asset.validated"
            : "technical-asset.validation-failed",
        aggregateType: "TECHNICAL_ASSET",
        aggregateId: asset.id,
        idempotencyKey: `${asset.id}:v${asset.version}`,
        payload: {
          ...technicalAssetAuditValue(asset),
          validationId: validation.id,
          decision: validation.decision,
          validatorId: validation.validatorId,
          assetVersion: validation.assetVersion
        }
      });
      return {
        asset: serializeTechnicalAsset(asset),
        validation: {
          id: validation.id,
          decision: validation.decision,
          evidence: validation.evidence,
          reason: validation.reason,
          validatorId: validation.validatorId,
          assetVersion: validation.assetVersion,
          validatedAt: validation.validatedAt.toISOString()
        },
        resourceVersion: asset.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}
