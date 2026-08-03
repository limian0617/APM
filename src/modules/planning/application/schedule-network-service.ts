import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  PROJECT_CALENDAR_AUDIT_FIELDS,
  TASK_DEPENDENCY_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import { PlanningError } from "../domain/planning-task";
import {
  assertDependencyGraphAcyclic,
  buildProjectCalendarRules,
  buildTaskDependencyDefinition,
  projectCalendarAllowedActions,
  taskDependencyAllowedActions,
  type ProjectCalendarRules,
  type TaskDependencyDefinition,
  type TaskDependencyTypeCode
} from "../domain/schedule-network";

const dependencyInclude = {
  predecessorTask: { select: { id: true, code: true, name: true, status: true } },
  successorTask: { select: { id: true, code: true, name: true, status: true } }
} satisfies Prisma.TaskDependencyInclude;

function nonNegativeVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PlanningError("INVALID_VERSION", "version 必须是非负整数。");
  }
  return value as number;
}

function positiveVersion(value: unknown): number {
  const version = nonNegativeVersion(value);
  if (version < 1) throw new PlanningError("INVALID_VERSION", "version 必须是正整数。");
  return version;
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
      throw new PlanningError("SCHEDULE_CONFLICT", "项目日历或任务依赖已经存在。", 409);
    }
    if (error.code === "P2003" || error.code === "P2004") {
      throw new PlanningError("SCHEDULE_RELATION_INVALID", "日历或依赖关系未通过数据库约束。", 409);
    }
  }
  throw error;
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
    throw new PlanningError("PROJECT_READ_ONLY", "已关闭项目不能修改计划网络。", 409);
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

type CalendarValue = {
  id: string;
  projectId: string;
  status: string;
  version: number;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type CalendarRevisionValue = {
  id: string;
  calendarId: string;
  projectId: string;
  revision: number;
  name: string;
  timeZone: string;
  weeklyRules: Prisma.JsonValue;
  exceptions: Prisma.JsonValue;
  checksum: string;
  reason: string;
  createdById: string;
  createdAt: Date;
};

function calendarAuditValue(calendar: CalendarValue, revision: CalendarRevisionValue) {
  return {
    projectId: calendar.projectId,
    calendarId: calendar.id,
    revisionId: revision.id,
    name: revision.name,
    timeZone: revision.timeZone,
    weeklyRuleCount: Array.isArray(revision.weeklyRules) ? revision.weeklyRules.length : 0,
    exceptionCount: Array.isArray(revision.exceptions) ? revision.exceptions.length : 0,
    checksum: revision.checksum,
    status: calendar.status,
    version: calendar.version
  };
}

function serializeCalendar(calendar: CalendarValue, revision: CalendarRevisionValue) {
  return {
    calendarId: calendar.id,
    projectId: calendar.projectId,
    name: revision.name,
    timeZone: revision.timeZone,
    weeklyRules: revision.weeklyRules,
    exceptions: revision.exceptions,
    checksum: revision.checksum,
    status: calendar.status,
    resourceVersion: calendar.version,
    revisionId: revision.id,
    revision: revision.revision,
    revisionReason: revision.reason,
    revisionCreatedById: revision.createdById,
    revisionCreatedAt: revision.createdAt,
    closedAt: calendar.closedAt,
    createdAt: calendar.createdAt,
    updatedAt: calendar.updatedAt,
    allowedActions: projectCalendarAllowedActions(calendar.status as "ACTIVE" | "CLOSED")
  };
}

async function loadCalendar(projectId: string, client: Prisma.TransactionClient | typeof db = db) {
  const calendar = await client.projectCalendar.findUnique({
    where: { projectId },
    include: { revisions: { orderBy: { revision: "desc" }, take: 1 } }
  });
  if (!calendar) throw new PlanningError("PROJECT_CALENDAR_NOT_FOUND", "项目工作日历不存在。", 404);
  const revision = calendar.revisions[0];
  if (!revision || (calendar.status === "ACTIVE" && revision.revision !== calendar.version)) {
    throw new Error("项目工作日历缺少当前修订。");
  }
  return { calendar, revision };
}

export async function getProjectCalendar(projectId: string) {
  const current = await loadCalendar(projectId);
  return { calendar: serializeCalendar(current.calendar, current.revision) };
}

export async function saveProjectCalendar(
  input: {
    projectId: string;
    version: number;
    name: string;
    timeZone: string;
    weeklyRules: Array<{
      dayOfWeek: number;
      intervals: Array<{ startMinute: number; endMinute: number }>;
    }>;
    exceptions: Array<{
      date: string;
      intervals: Array<{ startMinute: number; endMinute: number }>;
    }>;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = nonNegativeVersion(input.version);
  const rules = buildProjectCalendarRules(input);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const project = await client.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw new PlanningError("PROJECT_NOT_FOUND", "项目不存在。", 404);
      assertProjectWritable(project);
      const current = await client.projectCalendar.findUnique({
        where: { projectId: input.projectId },
        include: { revisions: { orderBy: { revision: "desc" }, take: 1 } }
      });

      if (!current) {
        if (expectedVersion !== 0) {
          throw new PlanningError("VERSION_CONFLICT", "项目日历尚未创建，version 必须为 0。", 409);
        }
        const calendar = await client.projectCalendar.create({
          data: {
            projectId: input.projectId,
            createdById: input.actorId,
            updatedById: input.actorId
          }
        });
        const revision = await createCalendarRevision(
          client,
          calendar,
          rules,
          reason,
          input.actorId
        );
        const auditValue = calendarAuditValue(calendar, revision);
        const audit = await writeAudit(client, {
          action: AUDIT_ACTIONS.PROJECT_CALENDAR_CREATED,
          objectType: AUDIT_OBJECT_TYPES.PROJECT_CALENDAR,
          objectId: calendar.id,
          context: commandAuditContext(input, project, reason),
          after: { value: auditValue, allowedFields: PROJECT_CALENDAR_AUDIT_FIELDS }
        });
        const event = await appendOutboxEvent(client, {
          eventType: "planning.project-calendar.created",
          aggregateType: "PROJECT_CALENDAR",
          aggregateId: calendar.id,
          idempotencyKey: `${calendar.id}:v${calendar.version}`,
          payload: auditValue
        });
        return {
          calendar: serializeCalendar(calendar, revision),
          resourceVersion: calendar.version,
          auditId: audit.id,
          outboxEventId: event.id
        };
      }

      if (current.status !== "ACTIVE") {
        throw new PlanningError("PROJECT_CALENDAR_CLOSED", "已关闭项目日历不能修改。", 409);
      }
      const currentRevision = current.revisions[0];
      if (!currentRevision || currentRevision.revision !== current.version) {
        throw new Error("项目工作日历缺少当前修订。");
      }
      const changed = await client.projectCalendar.updateMany({
        where: {
          id: current.id,
          projectId: input.projectId,
          version: expectedVersion,
          status: "ACTIVE"
        },
        data: { version: { increment: 1 }, updatedById: input.actorId }
      });
      if (changed.count !== 1) {
        throw new PlanningError("VERSION_CONFLICT", "项目日历已发生变化，请刷新后重试。", 409);
      }
      const calendar = await client.projectCalendar.findUniqueOrThrow({
        where: { id: current.id }
      });
      const revision = await createCalendarRevision(client, calendar, rules, reason, input.actorId);
      const before = calendarAuditValue(current, currentRevision);
      const after = calendarAuditValue(calendar, revision);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PROJECT_CALENDAR_UPDATED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_CALENDAR,
        objectId: calendar.id,
        context: commandAuditContext(input, project, reason),
        before: { value: before, allowedFields: PROJECT_CALENDAR_AUDIT_FIELDS },
        after: { value: after, allowedFields: PROJECT_CALENDAR_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "planning.project-calendar.updated",
        aggregateType: "PROJECT_CALENDAR",
        aggregateId: calendar.id,
        idempotencyKey: `${calendar.id}:v${calendar.version}`,
        payload: after
      });
      return {
        calendar: serializeCalendar(calendar, revision),
        resourceVersion: calendar.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof PlanningError) throw error;
    mapDatabaseError(error);
  }
}

async function createCalendarRevision(
  client: Prisma.TransactionClient,
  calendar: CalendarValue,
  rules: ProjectCalendarRules,
  reason: string,
  actorId: string
) {
  return client.projectCalendarRevision.create({
    data: {
      calendarId: calendar.id,
      projectId: calendar.projectId,
      revision: calendar.version,
      name: rules.name,
      timeZone: rules.timeZone,
      weeklyRules: rules.weeklyRules as Prisma.InputJsonValue,
      exceptions: rules.exceptions as Prisma.InputJsonValue,
      checksum: rules.checksum,
      reason,
      createdById: actorId
    }
  });
}

export async function closeProjectCalendar(
  input: {
    projectId: string;
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
      const current = await loadCalendar(input.projectId, client);
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      assertProjectWritable(project);
      const [clock] = await client.$queryRaw<
        Array<{ now: Date }>
      >`SELECT CURRENT_TIMESTAMP AS "now"`;
      if (!clock) throw new Error("无法读取数据库时间。");
      const changed = await client.projectCalendar.updateMany({
        where: { id: current.calendar.id, version, status: "ACTIVE" },
        data: {
          status: "CLOSED",
          closedAt: clock.now,
          version: { increment: 1 },
          updatedById: input.actorId
        }
      });
      if (changed.count !== 1) {
        throw new PlanningError("VERSION_CONFLICT", "项目日历已发生变化，请刷新后重试。", 409);
      }
      const calendar = await client.projectCalendar.findUniqueOrThrow({
        where: { id: current.calendar.id }
      });
      const before = calendarAuditValue(current.calendar, current.revision);
      const after = calendarAuditValue(calendar, current.revision);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PROJECT_CALENDAR_CLOSED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_CALENDAR,
        objectId: calendar.id,
        context: commandAuditContext(input, project, reason),
        before: { value: before, allowedFields: PROJECT_CALENDAR_AUDIT_FIELDS },
        after: { value: after, allowedFields: PROJECT_CALENDAR_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "planning.project-calendar.closed",
        aggregateType: "PROJECT_CALENDAR",
        aggregateId: calendar.id,
        idempotencyKey: `${calendar.id}:v${calendar.version}`,
        payload: after
      });
      return {
        calendar: serializeCalendar(calendar, current.revision),
        resourceVersion: calendar.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof PlanningError) throw error;
    mapDatabaseError(error);
  }
}

type DependencyValue = {
  id: string;
  projectId: string;
  predecessorTaskId: string;
  successorTaskId: string;
  dependencyType: string;
  lagMinutes: number;
  status: string;
  version: number;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function dependencyAuditValue(value: DependencyValue) {
  return {
    projectId: value.projectId,
    dependencyId: value.id,
    predecessorTaskId: value.predecessorTaskId,
    successorTaskId: value.successorTaskId,
    dependencyType: value.dependencyType,
    lagMinutes: value.lagMinutes,
    status: value.status,
    version: value.version
  };
}

function serializeDependency<T extends DependencyValue>(value: T) {
  return {
    ...dependencyAuditValue(value),
    resourceVersion: value.version,
    closedAt: value.closedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    predecessorTask: "predecessorTask" in value ? value.predecessorTask : undefined,
    successorTask: "successorTask" in value ? value.successorTask : undefined,
    allowedActions: taskDependencyAllowedActions(value.status as "ACTIVE" | "CLOSED")
  };
}

async function assertDependencyTasks(
  client: Prisma.TransactionClient,
  projectId: string,
  definition: TaskDependencyDefinition
) {
  const tasks = await client.planningTask.findMany({
    where: {
      projectId,
      id: { in: [definition.predecessorTaskId, definition.successorTaskId] }
    },
    select: { id: true, status: true }
  });
  if (tasks.length !== 2 || tasks.some((task) => task.status === "CLOSED")) {
    throw new PlanningError(
      "TASK_DEPENDENCY_RELATION_INVALID",
      "前置和后续任务必须属于本项目且未关闭。",
      409
    );
  }
}

async function lockDependencyGraph(client: Prisma.TransactionClient, projectId: string) {
  await client.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0)) IS NULL AS "locked"
  `;
}

export async function listTaskDependencies(input: {
  projectId: string;
  status?: "ACTIVE" | "CLOSED";
}) {
  const dependencies = await db.taskDependency.findMany({
    where: { projectId: input.projectId, ...(input.status ? { status: input.status } : {}) },
    include: dependencyInclude,
    orderBy: [{ predecessorTaskId: "asc" }, { successorTaskId: "asc" }]
  });
  return { dependencies: dependencies.map(serializeDependency) };
}

export async function createTaskDependency(
  input: {
    projectId: string;
    predecessorTaskId: string;
    successorTaskId: string;
    dependencyType: TaskDependencyTypeCode;
    lagMinutes: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const definition = buildTaskDependencyDefinition(input);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const project = await client.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw new PlanningError("PROJECT_NOT_FOUND", "项目不存在。", 404);
      assertProjectWritable(project);
      await lockDependencyGraph(client, input.projectId);
      await assertDependencyTasks(client, input.projectId, definition);
      const existing = await client.taskDependency.findMany({
        where: { projectId: input.projectId, status: "ACTIVE" },
        select: { predecessorTaskId: true, successorTaskId: true }
      });
      assertDependencyGraphAcyclic(existing, definition);
      const dependency = await client.taskDependency.create({
        data: {
          projectId: input.projectId,
          predecessorTaskId: definition.predecessorTaskId,
          successorTaskId: definition.successorTaskId,
          dependencyType: definition.dependencyType,
          lagMinutes: definition.lagMinutes,
          createdById: input.actorId,
          updatedById: input.actorId
        },
        include: dependencyInclude
      });
      const auditValue = dependencyAuditValue(dependency);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.TASK_DEPENDENCY_CREATED,
        objectType: AUDIT_OBJECT_TYPES.TASK_DEPENDENCY,
        objectId: dependency.id,
        context: commandAuditContext(input, project, reason),
        after: { value: auditValue, allowedFields: TASK_DEPENDENCY_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "planning.task-dependency.created",
        aggregateType: "TASK_DEPENDENCY",
        aggregateId: dependency.id,
        idempotencyKey: `${dependency.id}:v${dependency.version}`,
        payload: auditValue
      });
      return {
        dependency: serializeDependency(dependency),
        resourceVersion: dependency.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof PlanningError) throw error;
    mapDatabaseError(error);
  }
}

export async function updateTaskDependency(
  input: {
    projectId: string;
    dependencyId: string;
    version: number;
    dependencyType: TaskDependencyTypeCode;
    lagMinutes: number;
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
      const current = await client.taskDependency.findFirst({
        where: { id: input.dependencyId, projectId: input.projectId },
        include: dependencyInclude
      });
      if (!current) throw new PlanningError("TASK_DEPENDENCY_NOT_FOUND", "任务依赖不存在。", 404);
      if (current.status !== "ACTIVE") {
        throw new PlanningError("TASK_DEPENDENCY_CLOSED", "已关闭任务依赖不能修改。", 409);
      }
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      assertProjectWritable(project);
      const definition = buildTaskDependencyDefinition({
        predecessorTaskId: current.predecessorTaskId,
        successorTaskId: current.successorTaskId,
        dependencyType: input.dependencyType,
        lagMinutes: input.lagMinutes
      });
      await assertDependencyTasks(client, input.projectId, definition);
      const changed = await client.taskDependency.updateMany({
        where: { id: current.id, projectId: input.projectId, version, status: "ACTIVE" },
        data: {
          dependencyType: definition.dependencyType,
          lagMinutes: definition.lagMinutes,
          version: { increment: 1 },
          updatedById: input.actorId
        }
      });
      if (changed.count !== 1) {
        throw new PlanningError("VERSION_CONFLICT", "任务依赖已发生变化，请刷新后重试。", 409);
      }
      const dependency = await client.taskDependency.findUniqueOrThrow({
        where: { id: current.id },
        include: dependencyInclude
      });
      const before = dependencyAuditValue(current);
      const after = dependencyAuditValue(dependency);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.TASK_DEPENDENCY_UPDATED,
        objectType: AUDIT_OBJECT_TYPES.TASK_DEPENDENCY,
        objectId: dependency.id,
        context: commandAuditContext(input, project, reason),
        before: { value: before, allowedFields: TASK_DEPENDENCY_AUDIT_FIELDS },
        after: { value: after, allowedFields: TASK_DEPENDENCY_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "planning.task-dependency.updated",
        aggregateType: "TASK_DEPENDENCY",
        aggregateId: dependency.id,
        idempotencyKey: `${dependency.id}:v${dependency.version}`,
        payload: after
      });
      return {
        dependency: serializeDependency(dependency),
        resourceVersion: dependency.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof PlanningError) throw error;
    mapDatabaseError(error);
  }
}

export async function closeTaskDependency(
  input: {
    projectId: string;
    dependencyId: string;
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
      const current = await client.taskDependency.findFirst({
        where: { id: input.dependencyId, projectId: input.projectId },
        include: dependencyInclude
      });
      if (!current) throw new PlanningError("TASK_DEPENDENCY_NOT_FOUND", "任务依赖不存在。", 404);
      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      assertProjectWritable(project);
      const [clock] = await client.$queryRaw<
        Array<{ now: Date }>
      >`SELECT CURRENT_TIMESTAMP AS "now"`;
      if (!clock) throw new Error("无法读取数据库时间。");
      const changed = await client.taskDependency.updateMany({
        where: { id: current.id, projectId: input.projectId, version, status: "ACTIVE" },
        data: {
          status: "CLOSED",
          closedAt: clock.now,
          version: { increment: 1 },
          updatedById: input.actorId
        }
      });
      if (changed.count !== 1) {
        throw new PlanningError("VERSION_CONFLICT", "任务依赖已发生变化，请刷新后重试。", 409);
      }
      const dependency = await client.taskDependency.findUniqueOrThrow({
        where: { id: current.id },
        include: dependencyInclude
      });
      const before = dependencyAuditValue(current);
      const after = dependencyAuditValue(dependency);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.TASK_DEPENDENCY_CLOSED,
        objectType: AUDIT_OBJECT_TYPES.TASK_DEPENDENCY,
        objectId: dependency.id,
        context: commandAuditContext(input, project, reason),
        before: { value: before, allowedFields: TASK_DEPENDENCY_AUDIT_FIELDS },
        after: { value: after, allowedFields: TASK_DEPENDENCY_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "planning.task-dependency.closed",
        aggregateType: "TASK_DEPENDENCY",
        aggregateId: dependency.id,
        idempotencyKey: `${dependency.id}:v${dependency.version}`,
        payload: after
      });
      return {
        dependency: serializeDependency(dependency),
        resourceVersion: dependency.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof PlanningError) throw error;
    mapDatabaseError(error);
  }
}
