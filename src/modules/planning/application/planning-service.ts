import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  PLANNING_TASK_AUDIT_FIELDS,
  WBS_NODE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import { reconcileMilestonesForTask } from "@/modules/projects/application/milestone-service";

import {
  assertWbsParent,
  buildPlanningTaskDefinition,
  buildPlanningTaskProgress,
  buildWbsNodeDefinition,
  planningTaskAllowedActions,
  PlanningError,
  type PlanningTaskDefinition,
  type PlanningTaskStatusCode,
  type WbsNodeDefinition
} from "../domain/planning-task";
import { requestScheduleRecalculation } from "./schedule-recalculation-service";

const taskInclude = {
  ownerMembership: {
    select: {
      id: true,
      userId: true,
      projectRole: true,
      leftAt: true,
      user: { select: { id: true, name: true, status: true } }
    }
  },
  wbsNode: { select: { id: true, code: true, name: true, status: true } },
  responsibilityPackage: { select: { id: true, code: true, name: true, status: true } },
  deliveryUnit: { select: { id: true, code: true, name: true, status: true } },
  module: { select: { id: true, code: true, name: true, status: true, deliveryUnitId: true } }
} satisfies Prisma.PlanningTaskInclude;

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PlanningError("INVALID_VERSION", "version 必须是正整数。");
  }
  return value as number;
}

function commandReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new PlanningError("REASON_REQUIRED", "操作原因必须是 1 到 1024 个字符。");
  }
  return value.trim();
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new PlanningError("PLANNING_CONFLICT", "WBS/任务编号或排序位置已存在。", 409);
    }
    if (error.code === "P2003" || error.code === "P2004") {
      throw new PlanningError("PLANNING_RELATION_INVALID", "计划对象关系未通过数据库约束。", 409);
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

async function lockTaskDependencyGraph(client: Prisma.TransactionClient, projectId: string) {
  await client.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0)) IS NULL AS "locked"
  `;
}

function assertProjectWritable(project: {
  status: string;
  initializationStatus: string;
  structureStatus: string;
}) {
  if (project.initializationStatus !== "READY" || project.structureStatus !== "READY") {
    throw new PlanningError("PROJECT_STRUCTURE_NOT_READY", "项目模板和结构必须先完成初始化。", 409);
  }
  if (project.status === "CLOSED" || project.status === "CANCELED") {
    throw new PlanningError("PROJECT_READ_ONLY", "已关闭项目不能修改计划。", 409);
  }
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

function wbsAuditValue(value: {
  id: string;
  projectId: string;
  parentId: string | null;
  code: string;
  name: string;
  position: number;
  status: string;
  version: number;
}) {
  return {
    projectId: value.projectId,
    nodeId: value.id,
    parentId: value.parentId,
    code: value.code,
    name: value.name,
    position: value.position,
    status: value.status,
    version: value.version
  };
}

function serializeWbsNode<
  T extends {
    id: string;
    projectId: string;
    parentId: string | null;
    code: string;
    name: string;
    description: string | null;
    position: number;
    status: string;
    version: number;
    closedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }
>(value: T) {
  return {
    nodeId: value.id,
    projectId: value.projectId,
    parentId: value.parentId,
    code: value.code,
    name: value.name,
    description: value.description,
    position: value.position,
    status: value.status,
    resourceVersion: value.version,
    closedAt: value.closedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    allowedActions: value.status === "ACTIVE" ? (["UPDATE", "CLOSE"] as const) : ([] as const)
  };
}

async function assertWbsParentRelation(
  client: Prisma.TransactionClient,
  projectId: string,
  nodeId: string | null,
  definition: WbsNodeDefinition
) {
  assertWbsParent(nodeId, definition.parentId);
  let candidateId = definition.parentId;
  const visited = new Set<string>();
  while (candidateId) {
    if (candidateId === nodeId || visited.has(candidateId)) {
      throw new PlanningError("WBS_CYCLE", "WBS 父子关系不能形成循环。", 409);
    }
    visited.add(candidateId);
    const candidate = await client.wbsNode.findFirst({
      where: { id: candidateId, projectId },
      select: { parentId: true, status: true }
    });
    if (!candidate || candidate.status !== "ACTIVE") {
      throw new PlanningError(
        "WBS_PARENT_INVALID",
        "WBS 父节点必须属于本项目且处于启用状态。",
        409
      );
    }
    candidateId = candidate.parentId;
  }
}

export async function listWbsNodes(projectId: string, status?: "ACTIVE" | "CLOSED") {
  const rows = await db.wbsNode.findMany({
    where: { projectId, ...(status ? { status } : {}) },
    orderBy: [{ parentId: "asc" }, { position: "asc" }, { code: "asc" }]
  });
  return { wbsNodes: rows.map(serializeWbsNode) };
}

export async function getWbsNode(projectId: string, nodeId: string) {
  const node = await db.wbsNode.findFirst({
    where: { id: nodeId, projectId },
    include: {
      children: { orderBy: [{ position: "asc" }, { code: "asc" }] },
      tasks: { include: taskInclude, orderBy: [{ position: "asc" }, { code: "asc" }] }
    }
  });
  if (!node) throw new PlanningError("WBS_NOT_FOUND", "WBS 节点不存在。", 404);
  return {
    wbsNode: serializeWbsNode(node),
    children: node.children.map(serializeWbsNode),
    tasks: node.tasks.map(serializePlanningTask)
  };
}

export async function createWbsNode(
  input: {
    projectId: string;
    code: string;
    name: string;
    description?: string | null;
    parentId?: string | null;
    position: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const definition = buildWbsNodeDefinition(input);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const project = await client.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw new PlanningError("PROJECT_NOT_FOUND", "项目不存在。", 404);
      assertProjectWritable(project);
      await assertWbsParentRelation(client, input.projectId, null, definition);
      const created = await client.wbsNode.create({
        data: {
          projectId: input.projectId,
          parentId: definition.parentId,
          code: definition.code,
          name: definition.name,
          description: definition.description,
          position: definition.position,
          createdById: input.actorId,
          updatedById: input.actorId
        }
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.WBS_NODE_CREATED,
        objectType: AUDIT_OBJECT_TYPES.WBS_NODE,
        objectId: created.id,
        context: commandAuditContext(input, project, reason),
        after: { value: wbsAuditValue(created), allowedFields: WBS_NODE_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "planning.wbs-node.created",
        aggregateType: "WBS_NODE",
        aggregateId: created.id,
        idempotencyKey: `${created.id}:v${created.version}`,
        payload: wbsAuditValue(created)
      });
      return {
        wbsNode: serializeWbsNode(created),
        resourceVersion: created.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof PlanningError) throw error;
    mapDatabaseError(error);
  }
}

export async function updateWbsNode(
  input: Omit<Parameters<typeof createWbsNode>[0], "code"> & {
    nodeId: string;
    version: number;
  },
  transaction?: Prisma.TransactionClient
) {
  const version = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const current = await client.wbsNode.findFirst({
        where: { id: input.nodeId, projectId: input.projectId }
      });
      if (!current) throw new PlanningError("WBS_NOT_FOUND", "WBS 节点不存在。", 404);
      if (current.status !== "ACTIVE") {
        throw new PlanningError("WBS_NOT_EDITABLE", "已关闭 WBS 节点不能修改。", 409);
      }
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      assertProjectWritable(project);
      const definition = buildWbsNodeDefinition({ ...input, code: current.code });
      await assertWbsParentRelation(client, input.projectId, current.id, definition);
      const changed = await client.wbsNode.updateMany({
        where: { id: current.id, projectId: input.projectId, version, status: "ACTIVE" },
        data: {
          parentId: definition.parentId,
          name: definition.name,
          description: definition.description,
          position: definition.position,
          version: { increment: 1 },
          updatedById: input.actorId
        }
      });
      if (changed.count !== 1) {
        throw new PlanningError("VERSION_CONFLICT", "WBS 节点已发生变化，请刷新后重试。", 409);
      }
      const updated = await client.wbsNode.findUniqueOrThrow({ where: { id: current.id } });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.WBS_NODE_UPDATED,
        objectType: AUDIT_OBJECT_TYPES.WBS_NODE,
        objectId: updated.id,
        context: commandAuditContext(input, project, reason),
        before: { value: wbsAuditValue(current), allowedFields: WBS_NODE_AUDIT_FIELDS },
        after: { value: wbsAuditValue(updated), allowedFields: WBS_NODE_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "planning.wbs-node.updated",
        aggregateType: "WBS_NODE",
        aggregateId: updated.id,
        idempotencyKey: `${updated.id}:v${updated.version}`,
        payload: wbsAuditValue(updated)
      });
      return {
        wbsNode: serializeWbsNode(updated),
        resourceVersion: updated.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof PlanningError) throw error;
    mapDatabaseError(error);
  }
}

export async function closeWbsNode(
  input: {
    projectId: string;
    nodeId: string;
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
      const current = await client.wbsNode.findFirst({
        where: { id: input.nodeId, projectId: input.projectId }
      });
      if (!current) throw new PlanningError("WBS_NOT_FOUND", "WBS 节点不存在。", 404);
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      assertProjectWritable(project);
      const [activeChildren, openTasks] = await Promise.all([
        client.wbsNode.count({ where: { parentId: current.id, status: "ACTIVE" } }),
        client.planningTask.count({ where: { wbsNodeId: current.id, status: { not: "CLOSED" } } })
      ]);
      if (activeChildren || openTasks) {
        throw new PlanningError("WBS_NOT_EMPTY", "WBS 节点仍有启用子节点或未关闭任务。", 409);
      }
      const changed = await client.wbsNode.updateMany({
        where: { id: current.id, projectId: input.projectId, version, status: "ACTIVE" },
        data: {
          status: "CLOSED",
          closedAt: await databaseNow(client),
          version: { increment: 1 },
          updatedById: input.actorId
        }
      });
      if (changed.count !== 1) {
        throw new PlanningError("VERSION_CONFLICT", "WBS 节点已发生变化，请刷新后重试。", 409);
      }
      const updated = await client.wbsNode.findUniqueOrThrow({ where: { id: current.id } });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.WBS_NODE_CLOSED,
        objectType: AUDIT_OBJECT_TYPES.WBS_NODE,
        objectId: updated.id,
        context: commandAuditContext(input, project, reason),
        before: { value: wbsAuditValue(current), allowedFields: WBS_NODE_AUDIT_FIELDS },
        after: { value: wbsAuditValue(updated), allowedFields: WBS_NODE_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "planning.wbs-node.closed",
        aggregateType: "WBS_NODE",
        aggregateId: updated.id,
        idempotencyKey: `${updated.id}:v${updated.version}`,
        payload: wbsAuditValue(updated)
      });
      return {
        wbsNode: serializeWbsNode(updated),
        resourceVersion: updated.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof PlanningError) throw error;
    mapDatabaseError(error);
  }
}

function taskAuditValue(value: {
  id: string;
  projectId: string;
  wbsNodeId: string;
  responsibilityPackageId: string | null;
  deliveryUnitId: string | null;
  moduleId: string | null;
  ownerMembershipId: string;
  code: string;
  name: string;
  position: number;
  plannedStartAt: Date;
  plannedFinishAt: Date;
  plannedDurationMinutes: number;
  weight: number;
  status: string;
  actualStartAt: Date | null;
  actualFinishAt: Date | null;
  remainingDurationMinutes: number;
  forecastFinishAt: Date;
  version: number;
}) {
  return {
    projectId: value.projectId,
    taskId: value.id,
    wbsNodeId: value.wbsNodeId,
    responsibilityPackageId: value.responsibilityPackageId,
    deliveryUnitId: value.deliveryUnitId,
    moduleId: value.moduleId,
    ownerMembershipId: value.ownerMembershipId,
    code: value.code,
    name: value.name,
    position: value.position,
    plannedStartAt: value.plannedStartAt.toISOString(),
    plannedFinishAt: value.plannedFinishAt.toISOString(),
    plannedDurationMinutes: value.plannedDurationMinutes,
    weight: value.weight,
    status: value.status,
    actualStartAt: value.actualStartAt?.toISOString() ?? null,
    actualFinishAt: value.actualFinishAt?.toISOString() ?? null,
    remainingDurationMinutes: value.remainingDurationMinutes,
    forecastFinishAt: value.forecastFinishAt.toISOString(),
    version: value.version
  };
}

function serializePlanningTask<T extends Parameters<typeof taskAuditValue>[0]>(value: T) {
  return {
    ...taskAuditValue(value),
    description: "description" in value ? value.description : null,
    closedAt: "closedAt" in value ? value.closedAt : null,
    createdAt: "createdAt" in value ? value.createdAt : null,
    updatedAt: "updatedAt" in value ? value.updatedAt : null,
    owner: "ownerMembership" in value ? value.ownerMembership : undefined,
    wbsNode: "wbsNode" in value ? value.wbsNode : undefined,
    responsibilityPackage:
      "responsibilityPackage" in value ? value.responsibilityPackage : undefined,
    deliveryUnit: "deliveryUnit" in value ? value.deliveryUnit : undefined,
    module: "module" in value ? value.module : undefined,
    resourceVersion: value.version,
    allowedActions: planningTaskAllowedActions(value.status as PlanningTaskStatusCode)
  };
}

async function assertTaskRelations(
  client: Prisma.TransactionClient,
  projectId: string,
  definition: PlanningTaskDefinition
) {
  const [owner, wbsNode, responsibilityPackage, deliveryUnit, module] = await Promise.all([
    client.projectMember.findFirst({
      where: { id: definition.ownerMembershipId, projectId },
      include: { user: { select: { status: true } } }
    }),
    client.wbsNode.findFirst({
      where: { id: definition.wbsNodeId, projectId },
      select: { status: true }
    }),
    definition.responsibilityPackageId
      ? client.responsibilityPackage.findFirst({
          where: { id: definition.responsibilityPackageId, projectId },
          select: { status: true }
        })
      : null,
    definition.deliveryUnitId
      ? client.deliveryUnit.findFirst({
          where: { id: definition.deliveryUnitId, projectId },
          select: { status: true }
        })
      : null,
    definition.moduleId
      ? client.projectModule.findFirst({
          where: { id: definition.moduleId, projectId },
          select: { status: true, deliveryUnitId: true }
        })
      : null
  ]);
  if (!owner || owner.leftAt || owner.user.status !== "ACTIVE") {
    throw new PlanningError("TASK_OWNER_INVALID", "任务负责人必须是本项目有效成员。", 409);
  }
  if (!wbsNode || wbsNode.status !== "ACTIVE") {
    throw new PlanningError("TASK_WBS_INVALID", "任务 WBS 必须属于本项目且处于启用状态。", 409);
  }
  if (
    definition.responsibilityPackageId &&
    (!responsibilityPackage || responsibilityPackage.status === "CLOSED")
  ) {
    throw new PlanningError(
      "TASK_RESPONSIBILITY_PACKAGE_INVALID",
      "任务责任包必须属于本项目且未关闭。",
      409
    );
  }
  if (definition.deliveryUnitId && (!deliveryUnit || deliveryUnit.status !== "ACTIVE")) {
    throw new PlanningError(
      "TASK_STRUCTURE_INVALID",
      "任务交付单元必须属于本项目且处于启用状态。",
      409
    );
  }
  if (definition.moduleId && (!module || module.status !== "ACTIVE")) {
    throw new PlanningError(
      "TASK_STRUCTURE_INVALID",
      "任务模块必须属于本项目且处于启用状态。",
      409
    );
  }
  if (module && definition.deliveryUnitId && module.deliveryUnitId !== definition.deliveryUnitId) {
    throw new PlanningError("TASK_STRUCTURE_INVALID", "任务模块不属于所选交付单元。", 409);
  }
}

export async function listPlanningTasks(input: {
  projectId: string;
  status?: PlanningTaskStatusCode;
  wbsNodeId?: string;
}) {
  const rows = await db.planningTask.findMany({
    where: {
      projectId: input.projectId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.wbsNodeId ? { wbsNodeId: input.wbsNodeId } : {})
    },
    include: taskInclude,
    orderBy: [{ wbsNodeId: "asc" }, { position: "asc" }, { code: "asc" }]
  });
  return { tasks: rows.map(serializePlanningTask) };
}

export async function getPlanningTask(projectId: string, taskId: string) {
  const task = await db.planningTask.findFirst({
    where: { id: taskId, projectId },
    include: taskInclude
  });
  if (!task) throw new PlanningError("TASK_NOT_FOUND", "任务不存在。", 404);
  return { task: serializePlanningTask(task) };
}

export async function planningTaskOwnerUserId(projectId: string, taskId: string) {
  const task = await db.planningTask.findFirst({
    where: { id: taskId, projectId },
    select: { ownerMembership: { select: { userId: true } } }
  });
  return task?.ownerMembership.userId ?? null;
}

export async function createPlanningTask(
  input: {
    projectId: string;
    code: string;
    name: string;
    description?: string | null;
    wbsNodeId: string;
    responsibilityPackageId?: string | null;
    deliveryUnitId?: string | null;
    moduleId?: string | null;
    ownerMembershipId: string;
    position: number;
    plannedStartAt: string | Date;
    plannedFinishAt: string | Date;
    plannedDurationMinutes: number;
    weight: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const definition = buildPlanningTaskDefinition(input);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const project = await client.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw new PlanningError("PROJECT_NOT_FOUND", "项目不存在。", 404);
      assertProjectWritable(project);
      await assertTaskRelations(client, input.projectId, definition);
      const created = await client.planningTask.create({
        data: {
          projectId: input.projectId,
          wbsNodeId: definition.wbsNodeId,
          responsibilityPackageId: definition.responsibilityPackageId,
          deliveryUnitId: definition.deliveryUnitId,
          moduleId: definition.moduleId,
          ownerMembershipId: definition.ownerMembershipId,
          code: definition.code,
          name: definition.name,
          description: definition.description,
          position: definition.position,
          plannedStartAt: definition.plannedStartAt,
          plannedFinishAt: definition.plannedFinishAt,
          plannedDurationMinutes: definition.plannedDurationMinutes,
          weight: definition.weight,
          remainingDurationMinutes: definition.plannedDurationMinutes,
          forecastFinishAt: definition.plannedFinishAt,
          createdById: input.actorId,
          updatedById: input.actorId
        },
        include: taskInclude
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PLANNING_TASK_CREATED,
        objectType: AUDIT_OBJECT_TYPES.PLANNING_TASK,
        objectId: created.id,
        context: commandAuditContext(input, project, reason),
        after: { value: taskAuditValue(created), allowedFields: PLANNING_TASK_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "planning.task.created",
        aggregateType: "PLANNING_TASK",
        aggregateId: created.id,
        idempotencyKey: `${created.id}:v${created.version}`,
        payload: taskAuditValue(created)
      });
      await requestScheduleRecalculation(client, {
        projectId: input.projectId,
        actorId: input.actorId,
        sourceAction: "planning.task.created",
        reason
      });
      return {
        task: serializePlanningTask(created),
        resourceVersion: created.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof PlanningError) throw error;
    mapDatabaseError(error);
  }
}

export async function updatePlanningTask(
  input: Omit<Parameters<typeof createPlanningTask>[0], "code"> & {
    taskId: string;
    version: number;
  },
  transaction?: Prisma.TransactionClient
) {
  const version = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const current = await client.planningTask.findFirst({
        where: { id: input.taskId, projectId: input.projectId },
        include: taskInclude
      });
      if (!current) throw new PlanningError("TASK_NOT_FOUND", "任务不存在。", 404);
      if (current.status !== "NOT_STARTED") {
        throw new PlanningError("TASK_PLAN_NOT_EDITABLE", "任务开始后不能修改计划定义。", 409);
      }
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      assertProjectWritable(project);
      const definition = buildPlanningTaskDefinition({ ...input, code: current.code });
      await assertTaskRelations(client, input.projectId, definition);
      const changed = await client.planningTask.updateMany({
        where: {
          id: current.id,
          projectId: input.projectId,
          version,
          status: "NOT_STARTED"
        },
        data: {
          wbsNodeId: definition.wbsNodeId,
          responsibilityPackageId: definition.responsibilityPackageId,
          deliveryUnitId: definition.deliveryUnitId,
          moduleId: definition.moduleId,
          ownerMembershipId: definition.ownerMembershipId,
          name: definition.name,
          description: definition.description,
          position: definition.position,
          plannedStartAt: definition.plannedStartAt,
          plannedFinishAt: definition.plannedFinishAt,
          plannedDurationMinutes: definition.plannedDurationMinutes,
          weight: definition.weight,
          remainingDurationMinutes: definition.plannedDurationMinutes,
          forecastFinishAt: definition.plannedFinishAt,
          version: { increment: 1 },
          updatedById: input.actorId
        }
      });
      if (changed.count !== 1) {
        throw new PlanningError("VERSION_CONFLICT", "任务已发生变化，请刷新后重试。", 409);
      }
      const updated = await client.planningTask.findUniqueOrThrow({
        where: { id: current.id },
        include: taskInclude
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PLANNING_TASK_UPDATED,
        objectType: AUDIT_OBJECT_TYPES.PLANNING_TASK,
        objectId: updated.id,
        context: commandAuditContext(input, project, reason),
        before: { value: taskAuditValue(current), allowedFields: PLANNING_TASK_AUDIT_FIELDS },
        after: { value: taskAuditValue(updated), allowedFields: PLANNING_TASK_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "planning.task.updated",
        aggregateType: "PLANNING_TASK",
        aggregateId: updated.id,
        idempotencyKey: `${updated.id}:v${updated.version}`,
        payload: taskAuditValue(updated)
      });
      await requestScheduleRecalculation(client, {
        projectId: input.projectId,
        actorId: input.actorId,
        sourceAction: "planning.task.updated",
        reason
      });
      return {
        task: serializePlanningTask(updated),
        resourceVersion: updated.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof PlanningError) throw error;
    mapDatabaseError(error);
  }
}

export async function updatePlanningTaskProgress(
  input: {
    projectId: string;
    taskId: string;
    version: number;
    actualStartAt?: string | Date | null;
    actualFinishAt?: string | Date | null;
    remainingDurationMinutes: number;
    forecastFinishAt?: string | Date | null;
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
      const current = await client.planningTask.findFirst({
        where: { id: input.taskId, projectId: input.projectId },
        include: taskInclude
      });
      if (!current) throw new PlanningError("TASK_NOT_FOUND", "任务不存在。", 404);
      if (current.status === "CLOSED") {
        throw new PlanningError("TASK_NOT_EDITABLE", "已关闭任务不能更新进度。", 409);
      }
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      assertProjectWritable(project);
      if (current.ownerMembership.leftAt || current.ownerMembership.user.status !== "ACTIVE") {
        throw new PlanningError("TASK_OWNER_INVALID", "任务负责人必须仍为有效项目成员。", 409);
      }
      const progress = buildPlanningTaskProgress({
        plannedStartAt: current.plannedStartAt,
        actualStartAt: input.actualStartAt,
        actualFinishAt: input.actualFinishAt,
        remainingDurationMinutes: input.remainingDurationMinutes,
        forecastFinishAt: input.forecastFinishAt
      });
      const changed = await client.planningTask.updateMany({
        where: { id: current.id, projectId: input.projectId, version, status: { not: "CLOSED" } },
        data: {
          ...progress,
          version: { increment: 1 },
          updatedById: input.actorId
        }
      });
      if (changed.count !== 1) {
        throw new PlanningError("VERSION_CONFLICT", "任务已发生变化，请刷新后重试。", 409);
      }
      const updated = await client.planningTask.findUniqueOrThrow({
        where: { id: current.id },
        include: taskInclude
      });
      await reconcileMilestonesForTask(client, {
        projectId: input.projectId,
        taskId: updated.id,
        actorId: input.actorId,
        auditContext: commandAuditContext(input, project, reason),
        reason: `任务 ${updated.code} 完成状态更新：${reason}`
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PLANNING_TASK_PROGRESS_UPDATED,
        objectType: AUDIT_OBJECT_TYPES.PLANNING_TASK,
        objectId: updated.id,
        context: commandAuditContext(input, project, reason),
        before: { value: taskAuditValue(current), allowedFields: PLANNING_TASK_AUDIT_FIELDS },
        after: { value: taskAuditValue(updated), allowedFields: PLANNING_TASK_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "planning.task.progress-updated",
        aggregateType: "PLANNING_TASK",
        aggregateId: updated.id,
        idempotencyKey: `${updated.id}:v${updated.version}`,
        payload: taskAuditValue(updated)
      });
      await requestScheduleRecalculation(client, {
        projectId: input.projectId,
        actorId: input.actorId,
        sourceAction: "planning.task.progress-updated",
        reason
      });
      return {
        task: serializePlanningTask(updated),
        resourceVersion: updated.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof PlanningError) throw error;
    mapDatabaseError(error);
  }
}

export async function closePlanningTask(
  input: {
    projectId: string;
    taskId: string;
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
      const current = await client.planningTask.findFirst({
        where: { id: input.taskId, projectId: input.projectId },
        include: taskInclude
      });
      if (!current) throw new PlanningError("TASK_NOT_FOUND", "任务不存在。", 404);
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      assertProjectWritable(project);
      await lockTaskDependencyGraph(client, input.projectId);
      const activeDependencyCount = await client.taskDependency.count({
        where: {
          projectId: input.projectId,
          status: "ACTIVE",
          OR: [{ predecessorTaskId: current.id }, { successorTaskId: current.id }]
        }
      });
      if (activeDependencyCount > 0) {
        throw new PlanningError(
          "TASK_HAS_ACTIVE_DEPENDENCIES",
          "存在启用依赖的任务不能关闭，请先关闭相关依赖。",
          409
        );
      }
      const changed = await client.planningTask.updateMany({
        where: { id: current.id, projectId: input.projectId, version, status: { not: "CLOSED" } },
        data: {
          status: "CLOSED",
          closedAt: await databaseNow(client),
          version: { increment: 1 },
          updatedById: input.actorId
        }
      });
      if (changed.count !== 1) {
        throw new PlanningError("VERSION_CONFLICT", "任务已发生变化，请刷新后重试。", 409);
      }
      const updated = await client.planningTask.findUniqueOrThrow({
        where: { id: current.id },
        include: taskInclude
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PLANNING_TASK_CLOSED,
        objectType: AUDIT_OBJECT_TYPES.PLANNING_TASK,
        objectId: updated.id,
        context: commandAuditContext(input, project, reason),
        before: { value: taskAuditValue(current), allowedFields: PLANNING_TASK_AUDIT_FIELDS },
        after: { value: taskAuditValue(updated), allowedFields: PLANNING_TASK_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "planning.task.closed",
        aggregateType: "PLANNING_TASK",
        aggregateId: updated.id,
        idempotencyKey: `${updated.id}:v${updated.version}`,
        payload: taskAuditValue(updated)
      });
      await requestScheduleRecalculation(client, {
        projectId: input.projectId,
        actorId: input.actorId,
        sourceAction: "planning.task.closed",
        reason
      });
      return {
        task: serializePlanningTask(updated),
        resourceVersion: updated.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof PlanningError) throw error;
    mapDatabaseError(error);
  }
}
