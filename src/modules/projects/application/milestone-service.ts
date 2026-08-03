import { Prisma, ProjectMilestoneAchievementSource, ProjectMilestoneStatus } from "@prisma/client";

import { inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  PROJECT_MILESTONE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { TEMPLATE_COMPONENT_TYPES } from "@/modules/configuration/domain/template-policy";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

export class ProjectMilestoneError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ProjectMilestoneError";
  }
}

type ProjectMilestoneValue = {
  id: string;
  projectId: string;
  sourceSnapshotComponentId: string | null;
  code: string;
  name: string;
  description: string | null;
  position: number;
  targetAt: Date | null;
  status: ProjectMilestoneStatus;
  achievementSource: ProjectMilestoneAchievementSource | null;
  achievedAt: Date | null;
  voidedAt: Date | null;
  version: number;
};

type ProjectValue = {
  id: string;
  departmentId: string | null;
  status: string;
  initializationStatus: string;
  structureStatus: string;
};

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProjectMilestoneError("INVALID_VERSION", "version 必须是正整数。", 422);
  }
  return value as number;
}

function commandReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new ProjectMilestoneError("REASON_REQUIRED", "操作原因必须是 1 到 1024 个字符。", 422);
  }
  return value.trim();
}

function milestoneCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_.-]{1,99}$/u.test(value.trim())) {
    throw new ProjectMilestoneError("MILESTONE_CODE_INVALID", "里程碑代码格式无效。", 422);
  }
  return value.trim();
}

function milestoneName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) {
    throw new ProjectMilestoneError(
      "MILESTONE_NAME_INVALID",
      "里程碑名称必须是 1 到 200 个字符。",
      422
    );
  }
  return value.trim();
}

function milestoneDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length > 2000) {
    throw new ProjectMilestoneError(
      "MILESTONE_DESCRIPTION_INVALID",
      "里程碑说明不能超过 2000 个字符。",
      422
    );
  }
  return value.trim() || null;
}

function milestonePosition(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) {
    throw new ProjectMilestoneError(
      "MILESTONE_POSITION_INVALID",
      "里程碑位置必须是非负整数。",
      422
    );
  }
  return value as number;
}

function milestoneTargetAt(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(parsed.getTime())) {
    throw new ProjectMilestoneError("MILESTONE_TARGET_INVALID", "里程碑目标日期无效。", 422);
  }
  return parsed;
}

function assertProjectWritable(project: ProjectValue) {
  if (project.initializationStatus !== "READY" || project.structureStatus !== "READY") {
    throw new ProjectMilestoneError(
      "PROJECT_STRUCTURE_NOT_READY",
      "项目模板和结构必须先完成初始化。",
      409
    );
  }
  if (project.status === "CLOSED" || project.status === "CANCELED") {
    throw new ProjectMilestoneError("PROJECT_READ_ONLY", "项目已关闭，不能修改里程碑。", 409);
  }
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

function lifecycleAuditContext(
  input: { actorId: string; auditContext: AuditContext },
  project: ProjectValue,
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

function mapDatabaseError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new ProjectMilestoneError(
        "MILESTONE_CONFLICT",
        "里程碑代码、任务关联或事件序号已存在。",
        409
      );
    }
    if (error.code === "P2003" || error.code === "P2004") {
      throw new ProjectMilestoneError("MILESTONE_RELATION_INVALID", "里程碑关联未通过约束。", 409);
    }
  }
  throw error;
}

type SnapshotMilestoneDefinition = {
  code: string;
  name: string;
  description?: string;
  position: number;
};

export function shouldInstantiateMilestoneSnapshotComponent(input: {
  componentType: string;
  contentJson: unknown;
}): SnapshotMilestoneDefinition[] {
  if (input.componentType !== TEMPLATE_COMPONENT_TYPES.MILESTONE) {
    return [];
  }
  const content = input.contentJson as { milestones?: unknown };
  if (!Array.isArray(content.milestones)) {
    throw new ProjectMilestoneError(
      "MILESTONE_SNAPSHOT_INVALID",
      "项目里程碑模板快照内容无效。",
      409
    );
  }
  return content.milestones.map((milestone) => {
    const value = milestone as Record<string, unknown>;
    const position = value.position;
    if (
      typeof value.code !== "string" ||
      typeof value.name !== "string" ||
      !/^[A-Z][A-Z0-9_.-]{1,99}$/u.test(value.code) ||
      !value.name.trim() ||
      value.name.trim().length > 200 ||
      typeof position !== "number" ||
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position > 1_000_000 ||
      (typeof value.description !== "undefined" &&
        (typeof value.description !== "string" ||
          !value.description.trim() ||
          value.description.trim().length > 2000))
    ) {
      throw new ProjectMilestoneError(
        "MILESTONE_SNAPSHOT_INVALID",
        "项目里程碑模板快照内容无效。",
        409
      );
    }
    return value.description === undefined
      ? { code: value.code.trim(), name: value.name.trim(), position }
      : {
          code: value.code.trim(),
          name: value.name.trim(),
          description: value.description.trim(),
          position
        };
  });
}

export async function instantiateProjectMilestones(
  client: Prisma.TransactionClient,
  input: {
    projectId: string;
    project: ProjectValue;
    actorId: string;
    auditContext: AuditContext;
    components: ReadonlyArray<{
      id: string;
      componentType: string;
      contentJson: unknown;
    }>;
  }
) {
  const created = [];
  for (const component of input.components) {
    for (const definition of shouldInstantiateMilestoneSnapshotComponent(component)) {
      const milestone = await client.projectMilestone.create({
        data: {
          projectId: input.projectId,
          sourceSnapshotComponentId: component.id,
          code: definition.code,
          name: definition.name,
          description: definition.description ?? null,
          position: definition.position,
          createdById: input.actorId,
          updatedById: input.actorId
        }
      });
      const recorded = await recordMilestoneMutation(client, {
        project: input.project,
        milestone,
        eventType: "CREATED",
        reason: "从项目模板快照创建里程碑。",
        actorId: input.actorId,
        auditContext: lifecycleAuditContext(input, input.project, "从项目模板快照创建里程碑。")
      });
      const event = recorded.event;
      created.push({ milestone, event });
    }
  }
  return created;
}

function milestoneAuditValue(value: ProjectMilestoneValue) {
  return {
    projectId: value.projectId,
    milestoneId: value.id,
    code: value.code,
    name: value.name,
    description: value.description,
    position: value.position,
    targetAt: value.targetAt?.toISOString() ?? null,
    status: value.status,
    achievementSource: value.achievementSource,
    achievedAt: value.achievedAt?.toISOString() ?? null,
    voidedAt: value.voidedAt?.toISOString() ?? null,
    sourceSnapshotComponentId: value.sourceSnapshotComponentId,
    version: value.version
  };
}

function milestoneTaskLinkAuditValue(link: {
  id: string;
  taskId: string;
  status: string;
  voidReason: string | null;
}) {
  return {
    taskLinkId: link.id,
    taskId: link.taskId,
    taskLinkStatus: link.status,
    voidReason: link.voidReason
  };
}

function milestoneEventSnapshot(
  milestone: ProjectMilestoneValue,
  link?: {
    id: string;
    taskId: string;
    status: string;
    voidReason: string | null;
  } | null
) {
  return {
    ...milestoneAuditValue(milestone),
    description: milestone.description,
    position: milestone.position,
    achievedAt: milestone.achievedAt?.toISOString() ?? null,
    voidedAt: milestone.voidedAt?.toISOString() ?? null,
    sourceSnapshotComponentId: milestone.sourceSnapshotComponentId,
    taskLink: link
      ? { id: link.id, taskId: link.taskId, status: link.status, voidReason: link.voidReason }
      : null
  };
}

const mutationConfiguration = {
  CREATED: {
    auditAction: AUDIT_ACTIONS.PROJECT_MILESTONE_CREATED,
    outboxEventType: "project.milestone.created"
  },
  UPDATED: {
    auditAction: AUDIT_ACTIONS.PROJECT_MILESTONE_UPDATED,
    outboxEventType: "project.milestone.updated"
  },
  TASK_LINKED: {
    auditAction: AUDIT_ACTIONS.PROJECT_MILESTONE_TASK_LINKED,
    outboxEventType: "project.milestone.task-linked"
  },
  TASK_LINK_VOIDED: {
    auditAction: AUDIT_ACTIONS.PROJECT_MILESTONE_TASK_LINK_VOIDED,
    outboxEventType: "project.milestone.task-link-voided"
  },
  ACHIEVED_MANUALLY: {
    auditAction: AUDIT_ACTIONS.PROJECT_MILESTONE_ACHIEVED_MANUALLY,
    outboxEventType: "project.milestone.achieved-manually"
  },
  ACHIEVED_FROM_LINKED_TASKS: {
    auditAction: AUDIT_ACTIONS.PROJECT_MILESTONE_ACHIEVED_FROM_LINKED_TASKS,
    outboxEventType: "project.milestone.achieved-from-linked-tasks"
  },
  VOIDED: {
    auditAction: AUDIT_ACTIONS.PROJECT_MILESTONE_VOIDED,
    outboxEventType: "project.milestone.voided"
  }
} as const;

async function recordMilestoneMutation(
  client: Prisma.TransactionClient,
  input: {
    project: ProjectValue;
    milestone: ProjectMilestoneValue;
    previous?: ProjectMilestoneValue | null;
    eventType: keyof typeof mutationConfiguration;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
    link?: { id: string; taskId: string; status: string; voidReason: string | null } | null;
  }
) {
  const sequence =
    (await client.projectMilestoneEvent.count({ where: { milestoneId: input.milestone.id } })) + 1;
  const event = await client.projectMilestoneEvent.create({
    data: {
      projectId: input.project.id,
      milestoneId: input.milestone.id,
      sequence,
      eventType: input.eventType,
      fromStatus: input.previous?.status ?? null,
      toStatus: input.milestone.status,
      reason: input.reason,
      snapshotJson: milestoneEventSnapshot(input.milestone, input.link),
      actorId: input.actorId
    }
  });
  const configuration = mutationConfiguration[input.eventType];
  const audit = await writeAudit(client, {
    action: configuration.auditAction,
    objectType: AUDIT_OBJECT_TYPES.PROJECT_MILESTONE,
    objectId: input.milestone.id,
    context: input.auditContext,
    ...(input.previous
      ? {
          before: {
            value: milestoneAuditValue(input.previous),
            allowedFields: PROJECT_MILESTONE_AUDIT_FIELDS
          }
        }
      : {}),
    after: {
      value: milestoneAuditValue(input.milestone),
      allowedFields: PROJECT_MILESTONE_AUDIT_FIELDS
    },
    ...(input.link
      ? {
          metadata: {
            value: milestoneTaskLinkAuditValue(input.link),
            allowedFields: PROJECT_MILESTONE_AUDIT_FIELDS
          }
        }
      : {})
  });
  const outbox = await appendOutboxEvent(client, {
    eventType: configuration.outboxEventType,
    aggregateType: "PROJECT_MILESTONE",
    aggregateId: input.milestone.id,
    idempotencyKey: `${input.milestone.id}:v${input.milestone.version}`,
    payload: milestoneEventSnapshot(input.milestone, input.link)
  });
  return { event, auditId: audit.id, outboxEventId: outbox.id };
}

export async function manuallyAchieveProjectMilestone(
  input: {
    projectId: string;
    milestoneId: string;
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
      const [project, current] = await Promise.all([
        client.project.findUnique({ where: { id: input.projectId } }),
        client.projectMilestone.findFirst({
          where: { id: input.milestoneId, projectId: input.projectId }
        })
      ]);
      if (!project || !current) {
        throw new ProjectMilestoneError("MILESTONE_NOT_FOUND", "项目里程碑不存在。", 404);
      }
      assertProjectWritable(project);
      if (current.status !== "PENDING") {
        throw new ProjectMilestoneError("MILESTONE_STATE_INVALID", "当前状态不允许手动达成。", 409);
      }
      const changed = await client.projectMilestone.updateMany({
        where: { id: current.id, projectId: input.projectId, version, status: "PENDING" },
        data: {
          status: "ACHIEVED",
          achievementSource: "MANUAL",
          achievedAt: await databaseNow(client),
          version: { increment: 1 },
          updatedById: input.actorId
        }
      });
      if (changed.count !== 1) {
        throw new ProjectMilestoneError(
          "VERSION_CONFLICT",
          "里程碑已发生变化，请刷新后重试。",
          409
        );
      }
      const milestone = await client.projectMilestone.findUniqueOrThrow({
        where: { id: current.id }
      });
      const recorded = await recordMilestoneMutation(client, {
        project,
        milestone,
        previous: current,
        eventType: "ACHIEVED_MANUALLY",
        reason,
        actorId: input.actorId,
        auditContext: lifecycleAuditContext(input, project, reason)
      });
      return { milestone, ...recorded, resourceVersion: milestone.version };
    });
  } catch (error) {
    if (error instanceof ProjectMilestoneError) throw error;
    mapDatabaseError(error);
  }
}

export async function createProjectMilestone(
  input: {
    projectId: string;
    code: string;
    name: string;
    description?: string | null;
    position: number;
    targetAt?: string | Date | null;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const definition = {
    code: milestoneCode(input.code),
    name: milestoneName(input.name),
    description: milestoneDescription(input.description),
    position: milestonePosition(input.position),
    targetAt: milestoneTargetAt(input.targetAt)
  };
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const project = await client.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw new ProjectMilestoneError("PROJECT_NOT_FOUND", "项目不存在。", 404);
      assertProjectWritable(project);
      const milestone = await client.projectMilestone.create({
        data: {
          projectId: project.id,
          ...definition,
          createdById: input.actorId,
          updatedById: input.actorId
        }
      });
      const recorded = await recordMilestoneMutation(client, {
        project,
        milestone,
        eventType: "CREATED",
        reason,
        actorId: input.actorId,
        auditContext: lifecycleAuditContext(input, project, reason)
      });
      return { milestone, ...recorded, resourceVersion: milestone.version };
    });
  } catch (error) {
    if (error instanceof ProjectMilestoneError) throw error;
    mapDatabaseError(error);
  }
}

export async function updateProjectMilestone(
  input: {
    projectId: string;
    milestoneId: string;
    version: number;
    name: string;
    description?: string | null;
    position: number;
    targetAt?: string | Date | null;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const version = positiveVersion(input.version);
  const definition = {
    name: milestoneName(input.name),
    description: milestoneDescription(input.description),
    position: milestonePosition(input.position),
    targetAt: milestoneTargetAt(input.targetAt)
  };
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const [project, current] = await Promise.all([
        client.project.findUnique({ where: { id: input.projectId } }),
        client.projectMilestone.findFirst({
          where: { id: input.milestoneId, projectId: input.projectId }
        })
      ]);
      if (!project || !current)
        throw new ProjectMilestoneError("MILESTONE_NOT_FOUND", "项目里程碑不存在。", 404);
      assertProjectWritable(project);
      if (current.status === "VOID") {
        throw new ProjectMilestoneError("MILESTONE_STATE_INVALID", "已作废里程碑不能编辑。", 409);
      }
      const changed = await client.projectMilestone.updateMany({
        where: { id: current.id, projectId: project.id, version, status: { not: "VOID" } },
        data: { ...definition, version: { increment: 1 }, updatedById: input.actorId }
      });
      if (changed.count !== 1)
        throw new ProjectMilestoneError(
          "VERSION_CONFLICT",
          "里程碑已发生变化，请刷新后重试。",
          409
        );
      const milestone = await client.projectMilestone.findUniqueOrThrow({
        where: { id: current.id }
      });
      const recorded = await recordMilestoneMutation(client, {
        project,
        milestone,
        previous: current,
        eventType: "UPDATED",
        reason,
        actorId: input.actorId,
        auditContext: lifecycleAuditContext(input, project, reason)
      });
      return { milestone, ...recorded, resourceVersion: milestone.version };
    });
  } catch (error) {
    if (error instanceof ProjectMilestoneError) throw error;
    mapDatabaseError(error);
  }
}

export async function voidProjectMilestone(
  input: {
    projectId: string;
    milestoneId: string;
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
      const [project, current] = await Promise.all([
        client.project.findUnique({ where: { id: input.projectId } }),
        client.projectMilestone.findFirst({
          where: { id: input.milestoneId, projectId: input.projectId }
        })
      ]);
      if (!project || !current)
        throw new ProjectMilestoneError("MILESTONE_NOT_FOUND", "项目里程碑不存在。", 404);
      assertProjectWritable(project);
      if (current.status === "VOID") {
        throw new ProjectMilestoneError("MILESTONE_STATE_INVALID", "里程碑已经作废。", 409);
      }
      const changed = await client.projectMilestone.updateMany({
        where: { id: current.id, projectId: project.id, version, status: { not: "VOID" } },
        data: {
          status: "VOID",
          voidedAt: await databaseNow(client),
          version: { increment: 1 },
          updatedById: input.actorId
        }
      });
      if (changed.count !== 1)
        throw new ProjectMilestoneError(
          "VERSION_CONFLICT",
          "里程碑已发生变化，请刷新后重试。",
          409
        );
      const milestone = await client.projectMilestone.findUniqueOrThrow({
        where: { id: current.id }
      });
      const recorded = await recordMilestoneMutation(client, {
        project,
        milestone,
        previous: current,
        eventType: "VOIDED",
        reason,
        actorId: input.actorId,
        auditContext: lifecycleAuditContext(input, project, reason)
      });
      return { milestone, ...recorded, resourceVersion: milestone.version };
    });
  } catch (error) {
    if (error instanceof ProjectMilestoneError) throw error;
    mapDatabaseError(error);
  }
}

export async function linkMilestoneTask(
  input: {
    projectId: string;
    milestoneId: string;
    version: number;
    taskId: string;
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
      const [project, current, task] = await Promise.all([
        client.project.findUnique({ where: { id: input.projectId } }),
        client.projectMilestone.findFirst({
          where: { id: input.milestoneId, projectId: input.projectId }
        }),
        client.planningTask.findFirst({ where: { id: input.taskId, projectId: input.projectId } })
      ]);
      if (!project || !current)
        throw new ProjectMilestoneError("MILESTONE_NOT_FOUND", "项目里程碑不存在。", 404);
      assertProjectWritable(project);
      if (current.status === "VOID") {
        throw new ProjectMilestoneError(
          "MILESTONE_STATE_INVALID",
          "已作废里程碑不能关联任务。",
          409
        );
      }
      if (!task || task.status === "CLOSED") {
        throw new ProjectMilestoneError(
          "MILESTONE_TASK_RELATION_INVALID",
          "任务必须属于本项目且未关闭。",
          409
        );
      }
      const changed = await client.projectMilestone.updateMany({
        where: { id: current.id, projectId: project.id, version, status: { not: "VOID" } },
        data: { version: { increment: 1 }, updatedById: input.actorId }
      });
      if (changed.count !== 1)
        throw new ProjectMilestoneError(
          "VERSION_CONFLICT",
          "里程碑已发生变化，请刷新后重试。",
          409
        );
      const link = await client.projectMilestoneTaskLink.create({
        data: {
          projectId: project.id,
          milestoneId: current.id,
          taskId: task.id,
          createdById: input.actorId
        }
      });
      const milestone = await client.projectMilestone.findUniqueOrThrow({
        where: { id: current.id }
      });
      const recorded = await recordMilestoneMutation(client, {
        project,
        milestone,
        previous: current,
        eventType: "TASK_LINKED",
        reason,
        actorId: input.actorId,
        auditContext: lifecycleAuditContext(input, project, reason),
        link
      });
      return { milestone, link, ...recorded, resourceVersion: milestone.version };
    });
  } catch (error) {
    if (error instanceof ProjectMilestoneError) throw error;
    mapDatabaseError(error);
  }
}

export async function voidMilestoneTaskLink(
  input: {
    projectId: string;
    milestoneId: string;
    linkId: string;
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
      const [project, current, currentLink] = await Promise.all([
        client.project.findUnique({ where: { id: input.projectId } }),
        client.projectMilestone.findFirst({
          where: { id: input.milestoneId, projectId: input.projectId }
        }),
        client.projectMilestoneTaskLink.findFirst({
          where: { id: input.linkId, milestoneId: input.milestoneId, projectId: input.projectId }
        })
      ]);
      if (!project || !current)
        throw new ProjectMilestoneError("MILESTONE_NOT_FOUND", "项目里程碑不存在。", 404);
      assertProjectWritable(project);
      if (current.status === "VOID") {
        throw new ProjectMilestoneError(
          "MILESTONE_STATE_INVALID",
          "已作废里程碑不能修改关联任务。",
          409
        );
      }
      if (!currentLink)
        throw new ProjectMilestoneError(
          "MILESTONE_TASK_LINK_NOT_FOUND",
          "里程碑任务关联不存在。",
          404
        );
      if (currentLink.status === "VOID") {
        throw new ProjectMilestoneError("MILESTONE_STATE_INVALID", "里程碑任务关联已经作废。", 409);
      }
      const changed = await client.projectMilestone.updateMany({
        where: { id: current.id, projectId: project.id, version, status: { not: "VOID" } },
        data: { version: { increment: 1 }, updatedById: input.actorId }
      });
      if (changed.count !== 1)
        throw new ProjectMilestoneError(
          "VERSION_CONFLICT",
          "里程碑已发生变化，请刷新后重试。",
          409
        );
      const linkChanged = await client.projectMilestoneTaskLink.updateMany({
        where: {
          id: currentLink.id,
          milestoneId: current.id,
          projectId: project.id,
          status: "ACTIVE"
        },
        data: {
          status: "VOID",
          voidedById: input.actorId,
          voidedAt: await databaseNow(client),
          voidReason: reason
        }
      });
      if (linkChanged.count !== 1) {
        throw new ProjectMilestoneError(
          "VERSION_CONFLICT",
          "里程碑任务关联已发生变化，请刷新后重试。",
          409
        );
      }
      const [milestone, link] = await Promise.all([
        client.projectMilestone.findUniqueOrThrow({ where: { id: current.id } }),
        client.projectMilestoneTaskLink.findUniqueOrThrow({ where: { id: currentLink.id } })
      ]);
      const recorded = await recordMilestoneMutation(client, {
        project,
        milestone,
        previous: current,
        eventType: "TASK_LINK_VOIDED",
        reason,
        actorId: input.actorId,
        auditContext: lifecycleAuditContext(input, project, reason),
        link
      });
      return { milestone, link, ...recorded, resourceVersion: milestone.version };
    });
  } catch (error) {
    if (error instanceof ProjectMilestoneError) throw error;
    mapDatabaseError(error);
  }
}
