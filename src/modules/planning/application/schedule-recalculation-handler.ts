import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { JobExecution, JobHandler } from "@/modules/governance/contracts/jobs";
import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";

import {
  calculateSchedule,
  ScheduleCalculationError,
  SCHEDULE_ALGORITHM_VERSION,
  type ScheduleCalendarInput,
  type ScheduleDependencyInput,
  type ScheduleTaskInput
} from "../domain/schedule-calculation";

type RecalculationPayload = {
  recalculationId: string;
  projectId: string;
  inputVersion: number;
  algorithmVersion: string;
};

function payload(job: JobExecution): RecalculationPayload {
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
    throw new ScheduleCalculationError("INVALID_RECALCULATION_PAYLOAD", "计划重算负载无效。");
  }
  const value = job.payload as Record<string, JsonValue>;
  if (
    typeof value.recalculationId !== "string" ||
    !value.recalculationId.trim() ||
    typeof value.projectId !== "string" ||
    !value.projectId.trim() ||
    !Number.isSafeInteger(value.inputVersion) ||
    (value.inputVersion as number) < 1 ||
    value.algorithmVersion !== SCHEDULE_ALGORITHM_VERSION
  ) {
    throw new ScheduleCalculationError("INVALID_RECALCULATION_PAYLOAD", "计划重算负载无效。");
  }
  return {
    recalculationId: value.recalculationId,
    projectId: value.projectId,
    inputVersion: value.inputVersion as number,
    algorithmVersion: value.algorithmVersion
  };
}

async function databaseNow(client: Prisma.TransactionClient = db): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

function calendarInput(revision: {
  timeZone: string;
  weeklyRules: Prisma.JsonValue;
  exceptions: Prisma.JsonValue;
}): ScheduleCalendarInput {
  return {
    timeZone: revision.timeZone,
    weeklyRules: revision.weeklyRules as ScheduleCalendarInput["weeklyRules"],
    exceptions: revision.exceptions as ScheduleCalendarInput["exceptions"]
  };
}

function taskInput(task: {
  id: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "CLOSED";
  plannedStartAt: Date;
  plannedDurationMinutes: number;
  actualStartAt: Date | null;
  actualFinishAt: Date | null;
  remainingDurationMinutes: number;
}): ScheduleTaskInput {
  if (task.status === "CLOSED") {
    throw new ScheduleCalculationError(
      "CLOSED_TASK_IN_SCHEDULE_INPUT",
      "关闭任务不能进入计划重算输入。"
    );
  }
  return {
    taskId: task.id,
    status: task.status,
    plannedStartAt: task.plannedStartAt,
    plannedDurationMinutes: task.plannedDurationMinutes,
    actualStartAt: task.actualStartAt,
    actualFinishAt: task.actualFinishAt,
    remainingDurationMinutes: task.remainingDurationMinutes
  };
}

function dependencyInput(dependency: {
  predecessorTaskId: string;
  successorTaskId: string;
  dependencyType: "FS" | "SS" | "FF";
  lagMinutes: number;
}): ScheduleDependencyInput {
  return { ...dependency };
}

async function markFailed(input: RecalculationPayload, error: { code: string; message: string }) {
  const now = await databaseNow();
  await db.scheduleRecalculation.updateMany({
    where: {
      id: input.recalculationId,
      projectId: input.projectId,
      inputVersion: input.inputVersion,
      status: { in: ["PENDING", "RUNNING", "FAILED"] }
    },
    data: {
      status: "FAILED",
      completedAt: now,
      resultChecksum: null,
      errorCode: error.code.slice(0, 100),
      errorMessage: error.message.slice(0, 2048)
    }
  });
}

async function prepare(input: RecalculationPayload) {
  return db.$transaction(async (client) => {
    const recalculation = await client.scheduleRecalculation.findFirst({
      where: {
        id: input.recalculationId,
        projectId: input.projectId,
        inputVersion: input.inputVersion
      }
    });
    if (!recalculation) {
      throw new ScheduleCalculationError(
        "RECALCULATION_NOT_FOUND",
        "计划重算记录不存在或负载关系无效。"
      );
    }
    if (recalculation.status === "SUCCEEDED" || recalculation.status === "SUPERSEDED") {
      return { kind: "terminal" as const };
    }
    const state = await client.projectScheduleState.findUnique({
      where: { projectId: input.projectId }
    });
    if (!state) {
      throw new ScheduleCalculationError("SCHEDULE_STATE_NOT_FOUND", "项目计划状态不存在。");
    }
    if (state.inputVersion !== input.inputVersion) {
      await client.scheduleRecalculation.update({
        where: { id: recalculation.id },
        data: { status: "SUPERSEDED", completedAt: await databaseNow(client) }
      });
      return { kind: "terminal" as const };
    }
    const calendar = await client.projectCalendar.findFirst({
      where: { projectId: input.projectId, status: "ACTIVE" },
      include: { revisions: { orderBy: { revision: "desc" }, take: 1 } }
    });
    const revision = calendar?.revisions[0];
    if (!calendar || !revision || revision.revision !== calendar.version) {
      throw new ScheduleCalculationError(
        "ACTIVE_CALENDAR_REQUIRED",
        "项目必须配置启用的当前工作日历后才能重算计划。"
      );
    }
    const tasks = await client.planningTask.findMany({
      where: { projectId: input.projectId, status: { not: "CLOSED" } },
      orderBy: { id: "asc" },
      select: {
        id: true,
        status: true,
        plannedStartAt: true,
        plannedDurationMinutes: true,
        actualStartAt: true,
        actualFinishAt: true,
        remainingDurationMinutes: true
      }
    });
    const dependencies = await client.taskDependency.findMany({
      where: { projectId: input.projectId, status: "ACTIVE" },
      orderBy: { id: "asc" },
      select: {
        predecessorTaskId: true,
        successorTaskId: true,
        dependencyType: true,
        lagMinutes: true
      }
    });
    const snapshot = {
      projectId: input.projectId,
      inputVersion: input.inputVersion,
      algorithmVersion: input.algorithmVersion,
      asOf: recalculation.requestedAt.toISOString(),
      calendar: {
        revisionId: revision.id,
        checksum: revision.checksum,
        timeZone: revision.timeZone,
        weeklyRules: revision.weeklyRules,
        exceptions: revision.exceptions
      },
      tasks: tasks.map((task) => ({
        ...task,
        plannedStartAt: task.plannedStartAt.toISOString(),
        actualStartAt: task.actualStartAt?.toISOString() ?? null,
        actualFinishAt: task.actualFinishAt?.toISOString() ?? null
      })),
      dependencies
    };
    const checksum = payloadHash(snapshot);
    const now = await databaseNow(client);
    await client.scheduleRecalculation.update({
      where: { id: recalculation.id },
      data: {
        status: "RUNNING",
        calendarRevisionId: revision.id,
        inputChecksum: checksum.hash,
        inputSnapshot: checksum.value as Prisma.InputJsonValue,
        taskCount: tasks.length,
        dependencyCount: dependencies.length,
        startedAt: recalculation.startedAt ?? now,
        completedAt: null,
        resultChecksum: null,
        errorCode: null,
        errorMessage: null
      }
    });
    return {
      kind: "ready" as const,
      asOf: recalculation.requestedAt,
      calendar: calendarInput(revision),
      tasks: tasks.map(taskInput),
      dependencies: dependencies.map(dependencyInput)
    };
  });
}

async function publish(input: RecalculationPayload, result: ReturnType<typeof calculateSchedule>) {
  const resultValue = payloadHash({
    projectFinishAt: result.projectFinishAt?.toISOString() ?? null,
    tasks: result.tasks.map((task) => ({
      ...task,
      predictedStartAt: task.predictedStartAt.toISOString(),
      predictedFinishAt: task.predictedFinishAt.toISOString(),
      latestStartAt: task.latestStartAt.toISOString(),
      latestFinishAt: task.latestFinishAt.toISOString()
    }))
  });
  await db.$transaction(async (client) => {
    const recalculation = await client.scheduleRecalculation.findUnique({
      where: { id: input.recalculationId }
    });
    if (!recalculation || recalculation.status !== "RUNNING") return;
    if (result.tasks.length > 0) {
      await client.scheduleTaskForecast.createMany({
        data: result.tasks.map((task) => ({
          recalculationId: input.recalculationId,
          projectId: input.projectId,
          taskId: task.taskId,
          position: task.position,
          durationMinutes: task.durationMinutes,
          predictedStartAt: task.predictedStartAt,
          predictedFinishAt: task.predictedFinishAt,
          latestStartAt: task.latestStartAt,
          latestFinishAt: task.latestFinishAt,
          totalFloatMinutes: task.totalFloatMinutes,
          isCritical: task.isCritical
        }))
      });
    }
    const published = await client.projectScheduleState.updateMany({
      where: { projectId: input.projectId, inputVersion: input.inputVersion },
      data: {
        latestPublishedInputVersion: input.inputVersion,
        latestPublishedRecalculationId: input.recalculationId
      }
    });
    await client.scheduleRecalculation.update({
      where: { id: input.recalculationId },
      data: {
        status: published.count === 1 ? "SUCCEEDED" : "SUPERSEDED",
        resultChecksum: resultValue.hash,
        completedAt: await databaseNow(client),
        errorCode: null,
        errorMessage: null
      }
    });
  });
}

export function createScheduleRecalculationHandler(): JobHandler {
  return async (job) => {
    const input = payload(job);
    try {
      const prepared = await prepare(input);
      if (prepared.kind === "terminal") return;
      await publish(
        input,
        calculateSchedule({
          asOf: prepared.asOf,
          calendar: prepared.calendar,
          tasks: prepared.tasks,
          dependencies: prepared.dependencies
        })
      );
    } catch (error) {
      const failure =
        error instanceof ScheduleCalculationError
          ? { code: error.code, message: error.message }
          : {
              code:
                error instanceof Error
                  ? error.name || "SCHEDULE_RECALCULATION_FAILED"
                  : "SCHEDULE_RECALCULATION_FAILED",
              message: error instanceof Error ? error.message || "计划重算失败。" : "计划重算失败。"
            };
      await markFailed(input, failure);
      if (!(error instanceof ScheduleCalculationError)) throw error;
    }
  };
}
