import { Prisma } from "@prisma/client";

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
      typeof position !== "number" ||
      !Number.isSafeInteger(position) ||
      (typeof value.description !== "undefined" && typeof value.description !== "string")
    ) {
      throw new ProjectMilestoneError(
        "MILESTONE_SNAPSHOT_INVALID",
        "项目里程碑模板快照内容无效。",
        409
      );
    }
    return value.description === undefined
      ? { code: value.code, name: value.name, position }
      : {
          code: value.code,
          name: value.name,
          description: value.description,
          position
        };
  });
}

export async function instantiateProjectMilestones(
  client: Prisma.TransactionClient,
  input: {
    projectId: string;
    actorId: string;
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
      const event = await client.projectMilestoneEvent.create({
        data: {
          projectId: input.projectId,
          milestoneId: milestone.id,
          sequence: 1,
          eventType: "CREATED",
          fromStatus: null,
          toStatus: "PENDING",
          reason: "从项目模板快照创建里程碑。",
          snapshotJson: {
            milestoneId: milestone.id,
            projectId: milestone.projectId,
            code: milestone.code,
            name: milestone.name,
            description: milestone.description,
            position: milestone.position,
            status: milestone.status,
            version: milestone.version,
            sourceSnapshotComponentId: milestone.sourceSnapshotComponentId
          },
          actorId: input.actorId
        }
      });
      created.push({ milestone, event });
    }
  }
  return created;
}

function milestoneAuditValue(value: {
  id: string;
  projectId: string;
  code: string;
  name: string;
  status: string;
  achievementSource: string | null;
  version: number;
}) {
  return {
    projectId: value.projectId,
    milestoneId: value.id,
    code: value.code,
    name: value.name,
    status: value.status,
    achievementSource: value.achievementSource,
    version: value.version
  };
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
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new ProjectMilestoneError("INVALID_VERSION", "version 必须是正整数。", 422);
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 1024) {
    throw new ProjectMilestoneError("REASON_REQUIRED", "操作原因必须是 1 到 1024 个字符。", 422);
  }
  return inTransaction(transaction, async (client) => {
    const [project, current] = await Promise.all([
      client.project.findUnique({ where: { id: input.projectId } }),
      client.projectMilestone.findFirst({
        where: { id: input.milestoneId, projectId: input.projectId }
      })
    ]);
    if (!project || !current) {
      throw new ProjectMilestoneError("MILESTONE_NOT_FOUND", "项目里程碑不存在。", 404);
    }
    if (project.status === "CLOSED" || project.status === "CANCELED") {
      throw new ProjectMilestoneError("PROJECT_READ_ONLY", "项目已关闭，不能修改里程碑。", 409);
    }
    if (current.status !== "PENDING") {
      throw new ProjectMilestoneError("MILESTONE_STATE_INVALID", "当前状态不允许手动达成。", 409);
    }
    const now = new Date();
    const changed = await client.projectMilestone.updateMany({
      where: {
        id: current.id,
        projectId: input.projectId,
        version: input.version,
        status: "PENDING"
      },
      data: {
        status: "ACHIEVED",
        achievementSource: "MANUAL",
        achievedAt: now,
        version: { increment: 1 },
        updatedById: input.actorId
      }
    });
    if (changed.count !== 1) {
      throw new ProjectMilestoneError("VERSION_CONFLICT", "里程碑已发生变化，请刷新后重试。", 409);
    }
    const updated = await client.projectMilestone.findUniqueOrThrow({ where: { id: current.id } });
    const sequence =
      (await client.projectMilestoneEvent.count({ where: { milestoneId: current.id } })) + 1;
    const event = await client.projectMilestoneEvent.create({
      data: {
        projectId: updated.projectId,
        milestoneId: updated.id,
        sequence,
        eventType: "ACHIEVED_MANUALLY",
        fromStatus: current.status,
        toStatus: updated.status,
        reason,
        snapshotJson: milestoneAuditValue(updated),
        actorId: input.actorId
      }
    });
    const context = {
      ...input.auditContext,
      actorId: input.actorId,
      projectId: project.id,
      departmentId: project.departmentId,
      reason
    };
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.PROJECT_MILESTONE_ACHIEVED_MANUALLY,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_MILESTONE,
      objectId: updated.id,
      context,
      before: {
        value: milestoneAuditValue(current),
        allowedFields: PROJECT_MILESTONE_AUDIT_FIELDS
      },
      after: { value: milestoneAuditValue(updated), allowedFields: PROJECT_MILESTONE_AUDIT_FIELDS }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "project.milestone.achieved-manually",
      aggregateType: "PROJECT_MILESTONE",
      aggregateId: updated.id,
      idempotencyKey: `${updated.id}:v${updated.version}`,
      payload: milestoneAuditValue(updated)
    });
    return {
      milestone: updated,
      event,
      auditId: audit.id,
      outboxEventId: outbox.id,
      resourceVersion: updated.version
    };
  });
}
