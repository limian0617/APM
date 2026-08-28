import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  RESPONSIBILITY_PACKAGE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  buildResponsibilityPackageDefinition,
  nextResponsibilityPackageState,
  responsibilityPackageAllowedActions,
  ResponsibilityPackageError,
  type ResponsibilityPackageDefinition,
  type ResponsibilityPackageStatusCode,
  type ResponsibilityPackageTransitionCode
} from "../domain/responsibility-package";

const packageInclude = {
  ownerMembership: {
    select: {
      id: true,
      userId: true,
      projectRole: true,
      leftAt: true,
      user: { select: { id: true, name: true, status: true } }
    }
  },
  deliveryUnit: { select: { id: true, code: true, name: true, status: true } },
  module: { select: { id: true, code: true, name: true, status: true, deliveryUnitId: true } }
} satisfies Prisma.ResponsibilityPackageInclude;

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ResponsibilityPackageError("INVALID_VERSION", "version 必须是正整数。");
  }
  return value as number;
}

function commandReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new ResponsibilityPackageError("REASON_REQUIRED", "操作原因必须是 1 到 1024 个字符。");
  }
  return value.trim();
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new ResponsibilityPackageError(
        "RESPONSIBILITY_PACKAGE_CONFLICT",
        "责任包代码或事件顺序已存在。",
        409
      );
    }
    if (error.code === "P2003" || error.code === "P2004") {
      throw new ResponsibilityPackageError(
        "RESPONSIBILITY_PACKAGE_RELATION_INVALID",
        "责任包关系未通过数据库约束。",
        409
      );
    }
  }
  throw error;
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

function assertProjectWritable(project: {
  status: string;
  initializationStatus: string;
  structureStatus: string;
}) {
  if (project.initializationStatus !== "READY" || project.structureStatus !== "READY") {
    throw new ResponsibilityPackageError(
      "PROJECT_STRUCTURE_NOT_READY",
      "项目模板和结构必须先完成初始化。",
      409
    );
  }
  if (project.status === "CLOSED" || project.status === "CANCELED") {
    throw new ResponsibilityPackageError("PROJECT_READ_ONLY", "已关闭项目不能修改责任包。", 409);
  }
}

async function assertRelations(
  client: Prisma.TransactionClient,
  projectId: string,
  definition: ResponsibilityPackageDefinition
) {
  const [owner, deliveryUnit, module] = await Promise.all([
    client.projectMember.findFirst({
      where: { id: definition.ownerMembershipId, projectId },
      include: { user: { select: { status: true } } }
    }),
    definition.deliveryUnitId
      ? client.deliveryUnit.findFirst({
          where: { id: definition.deliveryUnitId, projectId },
          select: { id: true, status: true }
        })
      : null,
    definition.moduleId
      ? client.projectModule.findFirst({
          where: { id: definition.moduleId, projectId },
          select: { id: true, deliveryUnitId: true, status: true }
        })
      : null
  ]);
  if (!owner || owner.leftAt || owner.user.status !== "ACTIVE") {
    throw new ResponsibilityPackageError(
      "RESPONSIBILITY_PACKAGE_OWNER_INVALID",
      "Owner 必须是本项目的有效成员。",
      409
    );
  }
  if (definition.deliveryUnitId && (!deliveryUnit || deliveryUnit.status !== "ACTIVE")) {
    throw new ResponsibilityPackageError(
      "RESPONSIBILITY_PACKAGE_SCOPE_INVALID",
      "交付单元必须属于本项目且处于启用状态。",
      409
    );
  }
  if (definition.moduleId && (!module || module.status !== "ACTIVE")) {
    throw new ResponsibilityPackageError(
      "RESPONSIBILITY_PACKAGE_SCOPE_INVALID",
      "模块必须属于本项目且处于启用状态。",
      409
    );
  }
  if (module && definition.deliveryUnitId && module.deliveryUnitId !== definition.deliveryUnitId) {
    throw new ResponsibilityPackageError(
      "RESPONSIBILITY_PACKAGE_SCOPE_INVALID",
      "模块必须归属于所选交付单元。",
      409
    );
  }
}

function packageSnapshot(value: {
  id: string;
  projectId: string;
  deliveryUnitId: string | null;
  moduleId: string | null;
  code: string;
  name: string;
  description: string | null;
  ownerMembershipId: string;
  inputsJson: Prisma.JsonValue;
  outputsJson: Prisma.JsonValue;
  acceptanceCriteriaJson: Prisma.JsonValue;
  valueWeight: number;
  status: string;
  acceptanceCycle: number;
  transitionSequence: number;
  version: number;
}) {
  return {
    packageId: value.id,
    projectId: value.projectId,
    deliveryUnitId: value.deliveryUnitId,
    moduleId: value.moduleId,
    code: value.code,
    name: value.name,
    description: value.description,
    ownerMembershipId: value.ownerMembershipId,
    inputs: value.inputsJson,
    outputs: value.outputsJson,
    acceptanceCriteria: value.acceptanceCriteriaJson,
    valueWeight: value.valueWeight,
    status: value.status,
    acceptanceCycle: value.acceptanceCycle,
    transitionSequence: value.transitionSequence,
    version: value.version
  };
}

function auditValue(value: Parameters<typeof packageSnapshot>[0]) {
  return {
    projectId: value.projectId,
    packageId: value.id,
    code: value.code,
    name: value.name,
    deliveryUnitId: value.deliveryUnitId,
    moduleId: value.moduleId,
    ownerMembershipId: value.ownerMembershipId,
    inputCount: Array.isArray(value.inputsJson) ? value.inputsJson.length : 0,
    outputCount: Array.isArray(value.outputsJson) ? value.outputsJson.length : 0,
    acceptanceCriteriaCount: Array.isArray(value.acceptanceCriteriaJson)
      ? value.acceptanceCriteriaJson.length
      : 0,
    valueWeight: value.valueWeight,
    status: value.status,
    acceptanceCycle: value.acceptanceCycle,
    transitionSequence: value.transitionSequence,
    version: value.version
  };
}

function serializePackage<T extends Parameters<typeof packageSnapshot>[0]>(value: T) {
  return {
    ...packageSnapshot(value),
    acceptedAt: "acceptedAt" in value ? value.acceptedAt : null,
    closedAt: "closedAt" in value ? value.closedAt : null,
    createdAt: "createdAt" in value ? value.createdAt : null,
    updatedAt: "updatedAt" in value ? value.updatedAt : null,
    owner: "ownerMembership" in value ? value.ownerMembership : undefined,
    deliveryUnit: "deliveryUnit" in value ? value.deliveryUnit : undefined,
    module: "module" in value ? value.module : undefined,
    resourceVersion: value.version,
    allowedActions: responsibilityPackageAllowedActions(
      value.status as ResponsibilityPackageStatusCode
    )
  };
}

function commandAuditContext(
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

export async function listResponsibilityPackages(input: {
  projectId: string;
  status?: ResponsibilityPackageStatusCode;
  cursor?: string;
  limit: number;
}) {
  const rows = await db.responsibilityPackage.findMany({
    where: { projectId: input.projectId, ...(input.status ? { status: input.status } : {}) },
    include: packageInclude,
    orderBy: { id: "asc" },
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: input.limit + 1
  });
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  return {
    responsibilityPackages: page.map(serializePackage),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null
  };
}

export async function getResponsibilityPackage(projectId: string, packageId: string) {
  const value = await db.responsibilityPackage.findFirst({
    where: { id: packageId, projectId },
    include: {
      ...packageInclude,
      events: { orderBy: { sequence: "asc" } }
    }
  });
  if (!value) {
    throw new ResponsibilityPackageError("RESPONSIBILITY_PACKAGE_NOT_FOUND", "责任包不存在。", 404);
  }
  return { responsibilityPackage: serializePackage(value), events: value.events };
}

export async function responsibilityPackageOwnerUserId(projectId: string, packageId: string) {
  const value = await db.responsibilityPackage.findFirst({
    where: { id: packageId, projectId },
    select: { ownerMembership: { select: { userId: true } } }
  });
  return value?.ownerMembership.userId ?? null;
}

export async function createResponsibilityPackage(
  input: {
    projectId: string;
    code: string;
    name: string;
    description?: string | null;
    deliveryUnitId?: string | null;
    moduleId?: string | null;
    ownerMembershipId: string;
    inputs: Array<{ code: string; description: string }>;
    outputs: Array<{ code: string; description: string }>;
    acceptanceCriteria: Array<{ code: string; description: string }>;
    valueWeight: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const definition = buildResponsibilityPackageDefinition(input);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const project = await client.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw new ResponsibilityPackageError("PROJECT_NOT_FOUND", "项目不存在。", 404);
      assertProjectWritable(project);
      await assertRelations(client, input.projectId, definition);
      const created = await client.responsibilityPackage.create({
        data: {
          projectId: input.projectId,
          deliveryUnitId: definition.deliveryUnitId,
          moduleId: definition.moduleId,
          code: definition.code,
          name: definition.name,
          description: definition.description,
          ownerMembershipId: definition.ownerMembershipId,
          inputsJson: definition.inputs,
          outputsJson: definition.outputs,
          acceptanceCriteriaJson: definition.acceptanceCriteria,
          valueWeight: definition.valueWeight,
          createdById: input.actorId,
          updatedById: input.actorId
        },
        include: packageInclude
      });
      await client.responsibilityPackageEvent.create({
        data: {
          packageId: created.id,
          projectId: created.projectId,
          sequence: created.transitionSequence,
          acceptanceCycle: created.acceptanceCycle,
          eventType: "CREATED",
          fromStatus: null,
          toStatus: created.status,
          resourceVersion: created.version,
          reason,
          snapshotJson: packageSnapshot(created) as Prisma.InputJsonValue,
          actorId: input.actorId
        }
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.RESPONSIBILITY_PACKAGE_CREATED,
        objectType: AUDIT_OBJECT_TYPES.RESPONSIBILITY_PACKAGE,
        objectId: created.id,
        context: commandAuditContext(input, project, reason),
        after: { value: auditValue(created), allowedFields: RESPONSIBILITY_PACKAGE_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "project.responsibility-package.created",
        aggregateType: "RESPONSIBILITY_PACKAGE",
        aggregateId: created.id,
        idempotencyKey: `${created.id}:v${created.version}`,
        payload: auditValue(created)
      });
      return {
        responsibilityPackage: serializePackage(created),
        resourceVersion: created.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof ResponsibilityPackageError) throw error;
    mapDatabaseError(error);
  }
}

export async function updateResponsibilityPackage(
  input: Omit<Parameters<typeof createResponsibilityPackage>[0], "code"> & {
    packageId: string;
    version: number;
  },
  transaction?: Prisma.TransactionClient
) {
  const version = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const current = await client.responsibilityPackage.findFirst({
        where: { id: input.packageId, projectId: input.projectId },
        include: packageInclude
      });
      if (!current) {
        throw new ResponsibilityPackageError(
          "RESPONSIBILITY_PACKAGE_NOT_FOUND",
          "责任包不存在。",
          404
        );
      }
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      assertProjectWritable(project);
      if (current.status !== "OPEN") {
        throw new ResponsibilityPackageError(
          "RESPONSIBILITY_PACKAGE_NOT_EDITABLE",
          "责任包只允许在 OPEN 状态编辑。",
          409
        );
      }
      const definition = buildResponsibilityPackageDefinition({ ...input, code: current.code });
      await assertRelations(client, input.projectId, definition);
      const changed = await client.responsibilityPackage.updateMany({
        where: { id: current.id, projectId: input.projectId, version, status: "OPEN" },
        data: {
          deliveryUnitId: definition.deliveryUnitId,
          moduleId: definition.moduleId,
          name: definition.name,
          description: definition.description,
          ownerMembershipId: definition.ownerMembershipId,
          inputsJson: definition.inputs,
          outputsJson: definition.outputs,
          acceptanceCriteriaJson: definition.acceptanceCriteria,
          valueWeight: definition.valueWeight,
          version: { increment: 1 },
          updatedById: input.actorId
        }
      });
      if (changed.count !== 1) {
        throw new ResponsibilityPackageError(
          "VERSION_CONFLICT",
          "责任包已发生变化，请刷新后重试。",
          409
        );
      }
      const updated = await client.responsibilityPackage.findUniqueOrThrow({
        where: { id: current.id },
        include: packageInclude
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.RESPONSIBILITY_PACKAGE_UPDATED,
        objectType: AUDIT_OBJECT_TYPES.RESPONSIBILITY_PACKAGE,
        objectId: updated.id,
        context: commandAuditContext(input, project, reason),
        before: { value: auditValue(current), allowedFields: RESPONSIBILITY_PACKAGE_AUDIT_FIELDS },
        after: { value: auditValue(updated), allowedFields: RESPONSIBILITY_PACKAGE_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "project.responsibility-package.updated",
        aggregateType: "RESPONSIBILITY_PACKAGE",
        aggregateId: updated.id,
        idempotencyKey: `${updated.id}:v${updated.version}`,
        payload: auditValue(updated)
      });
      return {
        responsibilityPackage: serializePackage(updated),
        resourceVersion: updated.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof ResponsibilityPackageError) throw error;
    mapDatabaseError(error);
  }
}

const transitionConfiguration = {
  ACCEPTANCE_SUBMITTED: {
    auditAction: AUDIT_ACTIONS.RESPONSIBILITY_PACKAGE_ACCEPTANCE_SUBMITTED,
    eventType: "project.responsibility-package.acceptance-submitted"
  },
  ACCEPTED: {
    auditAction: AUDIT_ACTIONS.RESPONSIBILITY_PACKAGE_ACCEPTED,
    eventType: "project.responsibility-package.accepted"
  },
  REOPENED: {
    auditAction: AUDIT_ACTIONS.RESPONSIBILITY_PACKAGE_REOPENED,
    eventType: "project.responsibility-package.reopened"
  },
  CLOSED: {
    auditAction: AUDIT_ACTIONS.RESPONSIBILITY_PACKAGE_CLOSED,
    eventType: "project.responsibility-package.closed"
  }
} as const;

export async function transitionResponsibilityPackage(
  input: {
    projectId: string;
    packageId: string;
    transition: ResponsibilityPackageTransitionCode;
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
      const current = await client.responsibilityPackage.findFirst({
        where: { id: input.packageId, projectId: input.projectId },
        include: packageInclude
      });
      if (!current) {
        throw new ResponsibilityPackageError(
          "RESPONSIBILITY_PACKAGE_NOT_FOUND",
          "责任包不存在。",
          404
        );
      }
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      assertProjectWritable(project);
      if (
        input.transition === "ACCEPTANCE_SUBMITTED" &&
        (current.ownerMembership.leftAt || current.ownerMembership.user.status !== "ACTIVE")
      ) {
        throw new ResponsibilityPackageError(
          "RESPONSIBILITY_PACKAGE_OWNER_INVALID",
          "提交验收前必须重新指定有效 Owner。",
          409
        );
      }
      const next = nextResponsibilityPackageState(
        current.status as ResponsibilityPackageStatusCode,
        input.transition,
        current.acceptanceCycle
      );
      const now = await databaseNow(client);
      const timeData =
        input.transition === "ACCEPTED"
          ? { acceptedAt: now }
          : input.transition === "REOPENED"
            ? { acceptedAt: null }
            : input.transition === "CLOSED"
              ? { closedAt: now }
              : {};
      const changed = await client.responsibilityPackage.updateMany({
        where: {
          id: current.id,
          projectId: input.projectId,
          version,
          status: current.status
        },
        data: {
          status: next.status,
          acceptanceCycle: next.acceptanceCycle,
          transitionSequence: { increment: 1 },
          version: { increment: 1 },
          updatedById: input.actorId,
          ...timeData
        }
      });
      if (changed.count !== 1) {
        throw new ResponsibilityPackageError(
          "VERSION_CONFLICT",
          "责任包已发生变化，请刷新后重试。",
          409
        );
      }
      const updated = await client.responsibilityPackage.findUniqueOrThrow({
        where: { id: current.id },
        include: packageInclude
      });
      await client.responsibilityPackageEvent.create({
        data: {
          packageId: updated.id,
          projectId: updated.projectId,
          sequence: updated.transitionSequence,
          acceptanceCycle: updated.acceptanceCycle,
          eventType: input.transition,
          fromStatus: current.status,
          toStatus: updated.status,
          resourceVersion: updated.version,
          reason,
          snapshotJson: packageSnapshot(updated) as Prisma.InputJsonValue,
          actorId: input.actorId
        }
      });
      const configuration = transitionConfiguration[input.transition];
      const audit = await writeAudit(client, {
        action: configuration.auditAction,
        objectType: AUDIT_OBJECT_TYPES.RESPONSIBILITY_PACKAGE,
        objectId: updated.id,
        context: commandAuditContext(input, project, reason),
        before: { value: auditValue(current), allowedFields: RESPONSIBILITY_PACKAGE_AUDIT_FIELDS },
        after: { value: auditValue(updated), allowedFields: RESPONSIBILITY_PACKAGE_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: configuration.eventType,
        aggregateType: "RESPONSIBILITY_PACKAGE",
        aggregateId: updated.id,
        idempotencyKey: `${updated.id}:v${updated.version}`,
        payload: auditValue(updated)
      });
      return {
        responsibilityPackage: serializePackage(updated),
        resourceVersion: updated.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof ResponsibilityPackageError) throw error;
    mapDatabaseError(error);
  }
}
