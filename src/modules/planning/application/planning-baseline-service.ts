import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  PLANNING_BASELINE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import type { JsonValue } from "@/modules/governance/domain/idempotency";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  buildPlanningBaselineSnapshot,
  canonicalizePlanningBaselineSnapshotRows,
  PlanningBaselineError,
  type PlanningBaselineSnapshot
} from "../domain/planning-baseline";

const baselineInclude = {
  wbsSnapshots: { orderBy: { sourceWbsNodeId: "asc" } },
  taskSnapshots: { orderBy: { sourceTaskId: "asc" } },
  dependencySnapshots: { orderBy: { sourceDependencyId: "asc" } },
  milestoneSnapshots: { orderBy: { sourceMilestoneId: "asc" } },
  milestoneTaskLinkSnapshots: { orderBy: { sourceMilestoneTaskLinkId: "asc" } },
  calendarSnapshot: true
} satisfies Prisma.PlanningBaselineInclude;

type PlanningBaselineFact = Prisma.PlanningBaselineGetPayload<{
  include: typeof baselineInclude;
}>;

function commandReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new PlanningBaselineError("REASON_REQUIRED", "操作原因必须是 1 到 1024 个字符。", 422);
  }
  return value.trim();
}

function planningInputVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PlanningBaselineError("INVALID_VERSION", "planningInputVersion 必须是正整数。", 422);
  }
  return value as number;
}

function assertProjectWritable(project: {
  initializationStatus: string;
  structureStatus: string;
  status: string;
}) {
  if (project.initializationStatus !== "READY" || project.structureStatus !== "READY") {
    throw new PlanningBaselineError(
      "PROJECT_STRUCTURE_NOT_READY",
      "项目模板和结构必须先完成初始化。"
    );
  }
  if (project.status === "CLOSED" || project.status === "CANCELED") {
    throw new PlanningBaselineError("PROJECT_READ_ONLY", "已关闭项目不能冻结计划基线。");
  }
}

function baselineAuditValue(baseline: ReturnType<typeof serializePlanningBaseline>) {
  return {
    projectId: baseline.projectId,
    planningBaselineId: baseline.id,
    sourceGateSubmissionId: baseline.sourceGateSubmissionId,
    version: baseline.version,
    planningInputVersion: baseline.planningInputVersion,
    reason: baseline.reason,
    checksum: baseline.checksum,
    wbsSnapshotCount: baseline.wbsSnapshots.length,
    taskSnapshotCount: baseline.taskSnapshots.length,
    dependencySnapshotCount: baseline.dependencySnapshots.length,
    milestoneSnapshotCount: baseline.milestoneSnapshots.length,
    milestoneTaskLinkSnapshotCount: baseline.milestoneTaskLinkSnapshots.length,
    calendarSourceCalendarId: baseline.calendarSnapshot?.sourceCalendarId ?? null,
    calendarSourceCalendarRevisionId: baseline.calendarSnapshot?.sourceCalendarRevisionId ?? null
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

function asSnapshot<T>(value: Prisma.JsonValue): T {
  return value as unknown as T;
}

function serializePlanningBaseline(baseline: PlanningBaselineFact) {
  const snapshots = canonicalizePlanningBaselineSnapshotRows({
    wbsNodes: baseline.wbsSnapshots.map(({ snapshotJson }) =>
      asSnapshot<PlanningBaselineSnapshot["wbsNodes"][number]>(snapshotJson)
    ),
    tasks: baseline.taskSnapshots.map(({ snapshotJson }) =>
      asSnapshot<PlanningBaselineSnapshot["tasks"][number]>(snapshotJson)
    ),
    dependencies: baseline.dependencySnapshots.map(({ snapshotJson }) =>
      asSnapshot<PlanningBaselineSnapshot["dependencies"][number]>(snapshotJson)
    ),
    milestones: baseline.milestoneSnapshots.map(({ snapshotJson }) =>
      asSnapshot<PlanningBaselineSnapshot["milestones"][number]>(snapshotJson)
    ),
    milestoneTaskLinks: baseline.milestoneTaskLinkSnapshots.map(({ snapshotJson }) =>
      asSnapshot<PlanningBaselineSnapshot["milestoneTaskLinks"][number]>(snapshotJson)
    )
  });
  return {
    id: baseline.id,
    projectId: baseline.projectId,
    sourceGateSubmissionId: baseline.sourceGateSubmissionId,
    version: baseline.version,
    planningInputVersion: baseline.planningInputVersion,
    reason: baseline.reason,
    checksum: baseline.checksum,
    createdById: baseline.createdById,
    createdAt: baseline.createdAt.toISOString(),
    wbsSnapshots: snapshots.wbsNodes,
    taskSnapshots: snapshots.tasks,
    dependencySnapshots: snapshots.dependencies,
    milestoneSnapshots: snapshots.milestones,
    milestoneTaskLinkSnapshots: snapshots.milestoneTaskLinks,
    calendarSnapshot: baseline.calendarSnapshot
      ? asSnapshot<PlanningBaselineSnapshot["calendar"]>(baseline.calendarSnapshot.snapshotJson)
      : null
  };
}

async function lockProject(client: Prisma.TransactionClient, projectId: string) {
  await client.$queryRaw`
    SELECT "id" FROM "projects" WHERE "id" = ${projectId} FOR SHARE
  `;
  return client.project.findUnique({ where: { id: projectId } });
}

async function lockPlanningBaselineSources(client: Prisma.TransactionClient, projectId: string) {
  await client.$executeRaw`
    LOCK TABLE
      "wbs_nodes",
      "planning_tasks",
      "task_dependencies",
      "project_milestones",
      "project_milestone_task_links",
      "project_calendars",
      "project_calendar_revisions",
      "project_schedule_states"
    IN SHARE MODE
  `;
  await client.$queryRaw`
    SELECT "id" FROM "gate_submissions" WHERE "project_id" = ${projectId} FOR SHARE
  `;
}

async function readPlanningBaselineSource(client: Prisma.TransactionClient, projectId: string) {
  const [
    scheduleState,
    wbsNodes,
    tasks,
    dependencies,
    milestones,
    milestoneTaskLinks,
    calendar,
    approvedG1Submission
  ] = await Promise.all([
    client.projectScheduleState.findUnique({ where: { projectId } }),
    client.wbsNode.findMany({ where: { projectId } }),
    client.planningTask.findMany({ where: { projectId } }),
    client.taskDependency.findMany({ where: { projectId } }),
    client.projectMilestone.findMany({ where: { projectId } }),
    client.projectMilestoneTaskLink.findMany({ where: { projectId } }),
    client.projectCalendar.findUnique({ where: { projectId } }),
    client.gateSubmission.findFirst({
      where: {
        projectId,
        status: "APPROVED",
        gateInstance: {
          scope: "PROJECT",
          deliveryUnitId: null,
          moduleId: null,
          gateDefinition: { code: "G1", scope: "PROJECT" }
        }
      },
      orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
      select: { id: true }
    })
  ]);
  const revision = calendar
    ? await client.projectCalendarRevision.findFirst({
        where: { projectId, calendarId: calendar.id, revision: calendar.version }
      })
    : null;
  const calendarSource =
    calendar && revision
      ? {
          ...calendar,
          revision: {
            ...revision,
            weeklyRules: revision.weeklyRules as unknown as JsonValue,
            exceptions: revision.exceptions as unknown as JsonValue
          }
        }
      : null;

  return {
    scheduleState,
    approvedG1SubmissionId: approvedG1Submission?.id ?? null,
    calendar: calendarSource,
    wbsNodes,
    tasks,
    dependencies,
    milestones,
    milestoneTaskLinks
  };
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new PlanningBaselineError("PLANNING_BASELINE_V1_EXISTS", "项目已冻结计划基线 V1。");
    }
    if (error.code === "P2003" || error.code === "P2004") {
      throw new PlanningBaselineError(
        "PLANNING_BASELINE_SOURCE_INVALID",
        "计划基线的 Gate 或项目来源未通过数据库约束。"
      );
    }
  }
  throw error;
}

export async function freezeG1PlanningBaseline(
  input: {
    projectId: string;
    planningInputVersion: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const requestedInputVersion = planningInputVersion(input.planningInputVersion);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const project = await lockProject(client, input.projectId);
      if (!project) {
        throw new PlanningBaselineError("PROJECT_NOT_FOUND", "项目不存在。", 404);
      }
      assertProjectWritable(project);
      await lockPlanningBaselineSources(client, input.projectId);
      const source = await readPlanningBaselineSource(client, input.projectId);
      const { scheduleState } = source;
      if (!scheduleState || scheduleState.inputVersion !== requestedInputVersion) {
        throw new PlanningBaselineError(
          "PLANNING_BASELINE_INPUT_VERSION_CONFLICT",
          "计划输入已发生变化，请刷新后重新冻结基线。"
        );
      }
      const existing = await client.planningBaseline.findFirst({
        where: { projectId: input.projectId, version: 1 },
        select: { id: true }
      });
      if (existing) {
        throw new PlanningBaselineError("PLANNING_BASELINE_V1_EXISTS", "项目已冻结计划基线 V1。");
      }
      const snapshot = buildPlanningBaselineSnapshot({
        approvedG1SubmissionId: source.approvedG1SubmissionId,
        calendar: source.calendar,
        wbsNodes: source.wbsNodes,
        tasks: source.tasks,
        dependencies: source.dependencies,
        milestones: source.milestones,
        milestoneTaskLinks: source.milestoneTaskLinks
      });

      const created = await client.planningBaseline.create({
        data: {
          projectId: input.projectId,
          sourceGateSubmissionId: snapshot.approvedG1SubmissionId,
          version: 1,
          planningInputVersion: requestedInputVersion,
          reason,
          checksum: snapshot.checksum,
          createdById: input.actorId,
          wbsSnapshots: {
            create: snapshot.wbsNodes.map((value) => ({
              sourceWbsNodeId: value.sourceWbsNodeId,
              snapshotJson: value as Prisma.InputJsonValue
            }))
          },
          taskSnapshots: {
            create: snapshot.tasks.map((value) => ({
              sourceTaskId: value.sourceTaskId,
              snapshotJson: value as Prisma.InputJsonValue
            }))
          },
          dependencySnapshots: {
            create: snapshot.dependencies.map((value) => ({
              sourceDependencyId: value.sourceDependencyId,
              snapshotJson: value as Prisma.InputJsonValue
            }))
          },
          milestoneSnapshots: {
            create: snapshot.milestones.map((value) => ({
              sourceMilestoneId: value.sourceMilestoneId,
              snapshotJson: value as Prisma.InputJsonValue
            }))
          },
          milestoneTaskLinkSnapshots: {
            create: snapshot.milestoneTaskLinks.map((value) => ({
              sourceMilestoneTaskLinkId: value.sourceMilestoneTaskLinkId,
              snapshotJson: value as Prisma.InputJsonValue
            }))
          },
          calendarSnapshot: {
            create: {
              sourceCalendarId: snapshot.calendar.sourceCalendarId,
              sourceCalendarRevisionId: snapshot.calendar.sourceCalendarRevisionId,
              snapshotJson: snapshot.calendar as Prisma.InputJsonValue
            }
          }
        },
        include: baselineInclude
      });
      const baseline = serializePlanningBaseline(created);
      const auditValue = baselineAuditValue(baseline);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PLANNING_BASELINE_FROZEN,
        objectType: AUDIT_OBJECT_TYPES.PLANNING_BASELINE,
        objectId: baseline.id,
        context: commandAuditContext(input, project, reason),
        after: { value: auditValue, allowedFields: PLANNING_BASELINE_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "planning.baseline.frozen",
        aggregateType: "PLANNING_BASELINE",
        aggregateId: baseline.id,
        idempotencyKey: baseline.id,
        payload: auditValue
      });
      return { baseline, auditId: audit.id, outboxEventId: outbox.id };
    });
  } catch (error) {
    if (error instanceof PlanningBaselineError) throw error;
    mapDatabaseError(error);
  }
}

export async function listPlanningBaselines(input: { projectId: string }) {
  const baselines = await db.planningBaseline.findMany({
    where: { projectId: input.projectId },
    include: baselineInclude,
    orderBy: [{ version: "asc" }, { createdAt: "asc" }]
  });
  return { baselines: baselines.map(serializePlanningBaseline) };
}

export async function getPlanningBaseline(projectId: string, baselineId: string) {
  const baseline = await db.planningBaseline.findFirst({
    where: { id: baselineId, projectId },
    include: baselineInclude
  });
  if (!baseline) {
    throw new PlanningBaselineError("PLANNING_BASELINE_NOT_FOUND", "计划基线不存在。", 404);
  }
  return { baseline: serializePlanningBaseline(baseline) };
}
