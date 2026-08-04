import type { Prisma } from "@prisma/client";

import type { CockpitHealthInput } from "../domain/cockpit-health";

const activeAlertStatuses = ["TRIGGERED", "ACKNOWLEDGED", "IN_PROGRESS"] as const;

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

export type CockpitProjectionSource = {
  healthInput: CockpitHealthInput;
  sourceVersions: Record<string, unknown>;
};

export async function loadCockpitProjectionSource(
  client: Prisma.TransactionClient,
  projectId: string,
  now: Date
): Promise<CockpitProjectionSource | null> {
  const [project, scheduleState, gateInstances, alerts, overdueMilestones, latestAlertScan] =
    await Promise.all([
      client.project.findUnique({
        where: { id: projectId },
        select: { id: true, version: true, updatedAt: true }
      }),
      client.projectScheduleState.findUnique({
        where: { projectId },
        include: {
          latestPublishedRecalculation: {
            include: {
              taskForecasts: {
                where: { isCritical: true },
                include: {
                  task: {
                    select: { id: true, code: true, plannedFinishAt: true }
                  }
                },
                orderBy: { taskId: "asc" }
              }
            }
          }
        }
      }),
      client.projectGateInstance.findMany({
        where: { projectId },
        select: {
          id: true,
          version: true,
          gateDefinition: { select: { code: true } },
          checkSnapshots: {
            orderBy: { sequence: "desc" },
            take: 1,
            select: {
              id: true,
              sequence: true,
              status: true,
              resultChecksum: true,
              checkedAt: true
            }
          }
        },
        orderBy: { id: "asc" }
      }),
      client.projectAlert.findMany({
        where: {
          projectId,
          status: { in: [...activeAlertStatuses] },
          probability: "HIGH",
          impact: "HIGH"
        },
        select: {
          id: true,
          version: true,
          status: true,
          lastObservedAt: true,
          rule: { select: { code: true } }
        },
        orderBy: { id: "asc" }
      }),
      client.projectMilestone.findMany({
        where: { projectId, status: "PENDING", targetAt: { lt: now } },
        select: { id: true, code: true, version: true, targetAt: true, updatedAt: true },
        orderBy: { id: "asc" }
      }),
      client.projectAlertScan.findFirst({
        where: { projectId },
        select: { id: true, status: true, requestedAt: true, completedAt: true },
        orderBy: { requestedAt: "desc" }
      })
    ]);
  if (!project) return null;

  const latestSchedule = scheduleState
    ? await client.scheduleRecalculation.findUnique({
        where: {
          projectId_inputVersion: { projectId, inputVersion: scheduleState.inputVersion }
        },
        select: {
          id: true,
          inputVersion: true,
          status: true,
          algorithmVersion: true,
          requestedAt: true,
          completedAt: true,
          resultChecksum: true
        }
      })
    : null;
  const publishedSchedule = scheduleState?.latestPublishedRecalculation ?? null;
  const scheduleStateKind: CockpitHealthInput["schedule"]["state"] =
    !scheduleState || !latestSchedule
      ? "MISSING"
      : latestSchedule.status === "FAILED"
        ? "FAILED"
        : !publishedSchedule ||
            scheduleState.latestPublishedInputVersion !== scheduleState.inputVersion ||
            latestSchedule.status !== "SUCCEEDED"
          ? "STALE"
          : "CURRENT";
  const hardGateFailures = gateInstances.flatMap((instance) => {
    const snapshot = instance.checkSnapshots[0];
    return snapshot?.status === "HARD_FAILED"
      ? [
          {
            gateInstanceId: instance.id,
            gateCode: instance.gateDefinition.code,
            checkedAt: snapshot.checkedAt
          }
        ]
      : [];
  });
  const criticalPathDelays = (publishedSchedule?.taskForecasts ?? []).flatMap((forecast) =>
    forecast.predictedFinishAt > forecast.task.plannedFinishAt
      ? [
          {
            taskId: forecast.taskId,
            taskCode: forecast.task.code,
            plannedFinishAt: forecast.task.plannedFinishAt,
            predictedFinishAt: forecast.predictedFinishAt
          }
        ]
      : []
  );

  return {
    healthInput: {
      schedule: {
        state: scheduleStateKind,
        calculatedAt: publishedSchedule?.completedAt ?? latestSchedule?.completedAt ?? null
      },
      hardGateFailures,
      highRiskAlerts: alerts.map((alert) => ({
        alertId: alert.id,
        ruleCode: alert.rule.code,
        observedAt: alert.lastObservedAt
      })),
      criticalPathDelays,
      overdueMilestones: overdueMilestones.flatMap((milestone) =>
        milestone.targetAt
          ? [
              {
                milestoneId: milestone.id,
                milestoneCode: milestone.code,
                targetAt: milestone.targetAt
              }
            ]
          : []
      )
    },
    sourceVersions: {
      project: { version: project.version, updatedAt: iso(project.updatedAt) },
      schedule: scheduleState
        ? {
            inputVersion: scheduleState.inputVersion,
            latestPublishedInputVersion: scheduleState.latestPublishedInputVersion,
            updatedAt: iso(scheduleState.updatedAt),
            latest: latestSchedule
              ? {
                  id: latestSchedule.id,
                  status: latestSchedule.status,
                  algorithmVersion: latestSchedule.algorithmVersion,
                  requestedAt: iso(latestSchedule.requestedAt),
                  completedAt: iso(latestSchedule.completedAt),
                  resultChecksum: latestSchedule.resultChecksum
                }
              : null,
            published: publishedSchedule
              ? {
                  id: publishedSchedule.id,
                  inputVersion: publishedSchedule.inputVersion,
                  resultChecksum: publishedSchedule.resultChecksum,
                  completedAt: iso(publishedSchedule.completedAt),
                  criticalTaskForecasts: publishedSchedule.taskForecasts.map((forecast) => ({
                    taskId: forecast.taskId,
                    predictedFinishAt: iso(forecast.predictedFinishAt),
                    plannedFinishAt: iso(forecast.task.plannedFinishAt)
                  }))
                }
              : null
          }
        : null,
      gateChecks: gateInstances.map((instance) => ({
        gateInstanceId: instance.id,
        version: instance.version,
        latestCheck: instance.checkSnapshots[0]
          ? {
              id: instance.checkSnapshots[0].id,
              sequence: instance.checkSnapshots[0].sequence,
              status: instance.checkSnapshots[0].status,
              resultChecksum: instance.checkSnapshots[0].resultChecksum,
              checkedAt: iso(instance.checkSnapshots[0].checkedAt)
            }
          : null
      })),
      highRiskAlerts: alerts.map((alert) => ({
        alertId: alert.id,
        version: alert.version,
        status: alert.status,
        ruleCode: alert.rule.code,
        lastObservedAt: iso(alert.lastObservedAt)
      })),
      overdueMilestones: overdueMilestones.map((milestone) => ({
        milestoneId: milestone.id,
        version: milestone.version,
        targetAt: iso(milestone.targetAt),
        updatedAt: iso(milestone.updatedAt)
      })),
      alertScan: latestAlertScan
        ? {
            scanId: latestAlertScan.id,
            status: latestAlertScan.status,
            requestedAt: iso(latestAlertScan.requestedAt),
            completedAt: iso(latestAlertScan.completedAt)
          }
        : null
    }
  };
}
