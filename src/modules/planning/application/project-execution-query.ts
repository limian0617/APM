import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";

import { PlanningError } from "../domain/planning-task";
import { calculateProjectProgress } from "../domain/project-progress";
import { getProjectScheduleForecast } from "./schedule-recalculation-service";

const DEFAULT_MINUTES_PER_WORKDAY = 480;

type CalendarRule = {
  intervals?: Array<{ startMinute?: number; endMinute?: number }>;
};

function minutesPerWorkday(revision: Prisma.JsonValue | null | undefined) {
  if (!Array.isArray(revision) || revision.length === 0) return DEFAULT_MINUTES_PER_WORKDAY;
  const dailyMinutes = revision.flatMap((rule) => {
    const intervals = (rule as CalendarRule).intervals;
    if (!Array.isArray(intervals)) return [];
    return [
      intervals.reduce((total, interval) => {
        const start = interval.startMinute;
        const end = interval.endMinute;
        return (
          total +
          (typeof start === "number" &&
          typeof end === "number" &&
          Number.isInteger(start) &&
          Number.isInteger(end) &&
          end > start
            ? end - start
            : 0)
        );
      }, 0)
    ];
  });
  const total = dailyMinutes.reduce((sum, minutes) => sum + minutes, 0);
  return total > 0 ? total / dailyMinutes.length : DEFAULT_MINUTES_PER_WORKDAY;
}

export async function getProjectExecution(projectId: string) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      updatedAt: true,
      planningCalendar: {
        include: { revisions: { orderBy: { revision: "desc" }, take: 1 } }
      }
    }
  });
  if (!project) throw new PlanningError("PROJECT_NOT_FOUND", "项目不存在。", 404);

  const [tasks, responsibilityPackages, milestones, forecast] = await Promise.all([
    db.planningTask.findMany({
      where: { projectId, status: { not: "CLOSED" } },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        position: true,
        plannedStartAt: true,
        plannedFinishAt: true,
        actualStartAt: true,
        actualFinishAt: true,
        forecastFinishAt: true,
        plannedDurationMinutes: true,
        remainingDurationMinutes: true,
        responsibilityPackage: { select: { id: true, code: true, name: true, status: true } },
        ownerMembership: { select: { userId: true, user: { select: { name: true } } } }
      },
      orderBy: [{ position: "asc" }, { id: "asc" }]
    }),
    db.responsibilityPackage.findMany({
      where: { projectId },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        acceptedAt: true,
        closedAt: true,
        planningTasks: { where: { status: { not: "CLOSED" } }, select: { id: true } }
      },
      orderBy: { code: "asc" }
    }),
    db.projectMilestone.findMany({
      where: { projectId },
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        position: true,
        targetAt: true,
        status: true,
        achievementSource: true,
        achievedAt: true,
        voidedAt: true,
        version: true,
        taskLinks: {
          where: { status: "ACTIVE" },
          select: {
            id: true,
            taskId: true,
            task: { select: { code: true, name: true, status: true } }
          },
          orderBy: { createdAt: "asc" }
        }
      },
      orderBy: [{ position: "asc" }, { id: "asc" }]
    }),
    getProjectScheduleForecast(projectId)
  ]);

  const activeCalendar = project.planningCalendar?.status === "ACTIVE";
  const calendarRevision = activeCalendar ? project.planningCalendar?.revisions[0] : null;
  const progress = calculateProjectProgress(
    tasks.map((task) => ({
      status: task.status,
      plannedDurationMinutes: task.plannedDurationMinutes,
      remainingDurationMinutes: task.remainingDurationMinutes
    })),
    minutesPerWorkday(calendarRevision?.weeklyRules)
  );
  const schedule = forecast.schedule;
  const forecastByTaskId = new Map(schedule.tasks.map((task) => [task.taskId, task]));
  const calculatedAt = schedule.calculatedAt ?? schedule.requestedAt ?? project.updatedAt;
  const executionTasks = tasks.map((task) => {
    const taskForecast = forecastByTaskId.get(task.id);
    return {
      taskId: task.id,
      code: task.code,
      name: task.name,
      status: task.status,
      position: task.position,
      plannedStartAt: task.plannedStartAt,
      plannedFinishAt: task.plannedFinishAt,
      actualStartAt: task.actualStartAt,
      actualFinishAt: task.actualFinishAt,
      forecastFinishAt: task.forecastFinishAt,
      predictedStartAt: taskForecast?.predictedStartAt ?? null,
      predictedFinishAt: taskForecast?.predictedFinishAt ?? null,
      isCritical: taskForecast?.isCritical ?? false,
      responsibilityPackage: task.responsibilityPackage
        ? {
            packageId: task.responsibilityPackage.id,
            code: task.responsibilityPackage.code,
            name: task.responsibilityPackage.name,
            status: task.responsibilityPackage.status
          }
        : null,
      owner: { userId: task.ownerMembership.userId, name: task.ownerMembership.user.name }
    };
  });
  const criticalExceptions = executionTasks
    .filter(
      (task) =>
        task.isCritical &&
        task.predictedFinishAt !== null &&
        task.predictedFinishAt > task.plannedFinishAt
    )
    .map((task) => ({
      kind: "CRITICAL_PATH_DELAY" as const,
      taskId: task.taskId,
      code: task.code,
      name: task.name,
      plannedFinishAt: task.plannedFinishAt,
      predictedFinishAt: task.predictedFinishAt
    }));

  return {
    project: {
      projectId: project.id,
      code: project.code,
      name: project.name,
      status: project.status
    },
    progress:
      progress.status === "EMPTY"
        ? { status: "EMPTY" as const, calculatedAt }
        : { ...progress, calculatedAt },
    schedule: {
      status: schedule.status,
      stale:
        schedule.stale ||
        (schedule.inputVersion > 0 && schedule.publishedInputVersion !== schedule.inputVersion),
      inputVersion: schedule.inputVersion,
      publishedInputVersion: schedule.publishedInputVersion,
      requestedAt: schedule.requestedAt,
      calculatedAt: schedule.calculatedAt,
      algorithmVersion: schedule.algorithmVersion,
      projectFinishAt: schedule.projectFinishAt,
      error: schedule.error
    },
    tasks: executionTasks,
    criticalExceptions,
    responsibilityPackages: responsibilityPackages.map((responsibilityPackage) => ({
      packageId: responsibilityPackage.id,
      code: responsibilityPackage.code,
      name: responsibilityPackage.name,
      status: responsibilityPackage.status,
      acceptedAt: responsibilityPackage.acceptedAt,
      closedAt: responsibilityPackage.closedAt,
      effectiveTaskCount: responsibilityPackage.planningTasks.length
    })),
    milestones: milestones.map((milestone) => ({
      milestoneId: milestone.id,
      code: milestone.code,
      name: milestone.name,
      description: milestone.description,
      position: milestone.position,
      targetAt: milestone.targetAt,
      status: milestone.status,
      achievementSource: milestone.achievementSource,
      achievedAt: milestone.achievedAt,
      voidedAt: milestone.voidedAt,
      resourceVersion: milestone.version,
      links: milestone.taskLinks.map((link) => ({
        linkId: link.id,
        taskId: link.taskId,
        task: link.task
      }))
    }))
  };
}
