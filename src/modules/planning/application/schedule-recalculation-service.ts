import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import { SCHEDULE_ALGORITHM_VERSION } from "../domain/schedule-calculation";

function stableText(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new TypeError(`${field} 必须是 1 到 ${maximum} 个字符。`);
  }
  return normalized;
}

export async function requestScheduleRecalculation(
  client: Prisma.TransactionClient,
  input: {
    projectId: string;
    actorId: string;
    sourceAction: string;
    reason: string;
  }
) {
  const projectId = stableText(input.projectId, "projectId", 191);
  const sourceAction = stableText(input.sourceAction, "sourceAction", 191);
  const reason = stableText(input.reason, "reason", 1024);
  const state = await client.projectScheduleState.upsert({
    where: { projectId },
    create: { projectId, inputVersion: 1 },
    update: { inputVersion: { increment: 1 } }
  });
  const recalculation = await client.scheduleRecalculation.create({
    data: {
      projectId,
      inputVersion: state.inputVersion,
      algorithmVersion: SCHEDULE_ALGORITHM_VERSION,
      sourceAction,
      reason,
      requestedById: input.actorId
    }
  });
  const outboxEvent = await appendOutboxEvent(client, {
    eventType: "planning.schedule-recalculation.requested",
    aggregateType: "SCHEDULE_RECALCULATION",
    aggregateId: recalculation.id,
    idempotencyKey: `${projectId}:v${state.inputVersion}`,
    payload: {
      recalculationId: recalculation.id,
      projectId,
      inputVersion: state.inputVersion,
      algorithmVersion: SCHEDULE_ALGORITHM_VERSION
    }
  });
  return { state, recalculation, outboxEvent };
}

export async function getProjectScheduleForecast(projectId: string) {
  const state = await db.projectScheduleState.findUnique({
    where: { projectId },
    include: {
      latestPublishedRecalculation: {
        include: {
          taskForecasts: {
            orderBy: { position: "asc" },
            include: {
              task: { select: { id: true, code: true, name: true, status: true } }
            }
          }
        }
      }
    }
  });
  if (!state) {
    return {
      schedule: {
        status: "NOT_REQUESTED",
        inputVersion: 0,
        publishedInputVersion: null,
        stale: false,
        requestedAt: null,
        calculatedAt: null,
        calculationTimeMs: null,
        algorithmVersion: SCHEDULE_ALGORITHM_VERSION,
        projectFinishAt: null,
        error: null,
        tasks: []
      }
    };
  }
  const latest = await db.scheduleRecalculation.findUnique({
    where: { projectId_inputVersion: { projectId, inputVersion: state.inputVersion } }
  });
  if (!latest) throw new Error("项目计划输入版本缺少重算记录。");
  const published = state.latestPublishedRecalculation;
  const taskForecasts = published?.taskForecasts ?? [];
  const projectFinishAt = taskForecasts.reduce<Date | null>(
    (current, value) =>
      !current || value.predictedFinishAt > current ? value.predictedFinishAt : current,
    null
  );
  return {
    schedule: {
      status: latest.status,
      inputVersion: state.inputVersion,
      publishedInputVersion: state.latestPublishedInputVersion,
      stale:
        state.latestPublishedInputVersion !== null &&
        state.latestPublishedInputVersion !== state.inputVersion,
      requestedAt: latest.requestedAt,
      calculatedAt: published?.completedAt ?? null,
      calculationTimeMs:
        published?.startedAt && published.completedAt
          ? Math.max(0, published.completedAt.getTime() - published.startedAt.getTime())
          : null,
      algorithmVersion: latest.algorithmVersion,
      projectFinishAt,
      error:
        latest.status === "FAILED"
          ? { code: latest.errorCode, message: latest.errorMessage }
          : null,
      tasks: taskForecasts.map((value) => ({
        taskId: value.taskId,
        task: value.task,
        position: value.position,
        durationMinutes: value.durationMinutes,
        predictedStartAt: value.predictedStartAt,
        predictedFinishAt: value.predictedFinishAt,
        latestStartAt: value.latestStartAt,
        latestFinishAt: value.latestFinishAt,
        totalFloatMinutes: value.totalFloatMinutes,
        isCritical: value.isCritical
      }))
    }
  };
}
