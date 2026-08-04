export const COCKPIT_HEALTH_STATUSES = ["UNKNOWN", "HEALTHY", "ATTENTION", "CRITICAL"] as const;
export type CockpitHealthStatus = (typeof COCKPIT_HEALTH_STATUSES)[number];

export const COCKPIT_EXCEPTION_KINDS = [
  "SCHEDULE_FAILED",
  "SCHEDULE_STALE",
  "CRITICAL_PATH_DELAY",
  "MILESTONE_OVERDUE",
  "GATE_HARD_FAILURE",
  "HIGH_RISK_ALERT"
] as const;
export type CockpitExceptionKind = (typeof COCKPIT_EXCEPTION_KINDS)[number];

export type CockpitExceptionSeverity = "ATTENTION" | "CRITICAL";

export type CockpitHealthInput = {
  schedule: { state: "MISSING" | "CURRENT" | "STALE" | "FAILED"; calculatedAt: Date | null };
  hardGateFailures: Array<{ gateInstanceId: string; gateCode: string; checkedAt: Date }>;
  highRiskAlerts: Array<{ alertId: string; ruleCode: string; observedAt: Date }>;
  criticalPathDelays: Array<{
    taskId: string;
    taskCode: string;
    plannedFinishAt: Date;
    predictedFinishAt: Date;
  }>;
  overdueMilestones: Array<{ milestoneId: string; milestoneCode: string; targetAt: Date }>;
};

export type CockpitHealthException = {
  kind: CockpitExceptionKind;
  sourceKey: string;
  severity: CockpitExceptionSeverity;
  summary: string;
  occurredAt: Date | null;
  drilldownPath: string;
};

function compareExceptions(left: CockpitHealthException, right: CockpitHealthException) {
  const severity = Number(right.severity === "CRITICAL") - Number(left.severity === "CRITICAL");
  if (severity !== 0) return severity;
  const occurredAt = (right.occurredAt?.getTime() ?? 0) - (left.occurredAt?.getTime() ?? 0);
  if (occurredAt !== 0) return occurredAt;
  return left.sourceKey.localeCompare(right.sourceKey);
}

export function deriveCockpitHealth(input: CockpitHealthInput) {
  const exceptions: CockpitHealthException[] = [];

  if (input.schedule.state === "MISSING") {
    exceptions.push({
      kind: "SCHEDULE_STALE",
      sourceKey: "schedule",
      severity: "ATTENTION",
      summary: "尚无已发布的计划预测，无法确认项目计划健康度。",
      occurredAt: null,
      drilldownPath: "/api/projects/{projectId}/schedule-forecast"
    });
  }
  if (input.schedule.state === "STALE") {
    exceptions.push({
      kind: "SCHEDULE_STALE",
      sourceKey: "schedule",
      severity: "ATTENTION",
      summary: "计划预测已过期，需要重新计算。",
      occurredAt: input.schedule.calculatedAt,
      drilldownPath: "/api/projects/{projectId}/schedule-forecast"
    });
  }
  if (input.schedule.state === "FAILED") {
    exceptions.push({
      kind: "SCHEDULE_FAILED",
      sourceKey: "schedule",
      severity: "ATTENTION",
      summary: "计划预测计算失败，需要处理后重新计算。",
      occurredAt: input.schedule.calculatedAt,
      drilldownPath: "/api/projects/{projectId}/schedule-forecast"
    });
  }

  exceptions.push(
    ...input.hardGateFailures.map((value) => ({
      kind: "GATE_HARD_FAILURE" as const,
      sourceKey: value.gateInstanceId,
      severity: "CRITICAL" as const,
      summary: `Gate ${value.gateCode} 存在硬失败检查项。`,
      occurredAt: value.checkedAt,
      drilldownPath: "/api/projects/{projectId}/gates"
    }))
  );
  exceptions.push(
    ...input.highRiskAlerts.map((value) => ({
      kind: "HIGH_RISK_ALERT" as const,
      sourceKey: value.alertId,
      severity: "CRITICAL" as const,
      summary: `预警规则 ${value.ruleCode} 的概率与影响均为高。`,
      occurredAt: value.observedAt,
      drilldownPath: "/api/projects/{projectId}/alerts"
    }))
  );
  exceptions.push(
    ...input.criticalPathDelays.map((value) => ({
      kind: "CRITICAL_PATH_DELAY" as const,
      sourceKey: value.taskId,
      severity: "ATTENTION" as const,
      summary: `关键路径任务 ${value.taskCode} 的预测完成日期晚于计划完成日期。`,
      occurredAt: value.predictedFinishAt,
      drilldownPath: "/api/projects/{projectId}/schedule-forecast"
    }))
  );
  exceptions.push(
    ...input.overdueMilestones.map((value) => ({
      kind: "MILESTONE_OVERDUE" as const,
      sourceKey: value.milestoneId,
      severity: "ATTENTION" as const,
      summary: `里程碑 ${value.milestoneCode} 已超过目标日期。`,
      occurredAt: value.targetAt,
      drilldownPath: "/api/projects/{projectId}/milestones"
    }))
  );

  const orderedExceptions = exceptions.sort(compareExceptions);
  const health: CockpitHealthStatus = orderedExceptions.some(
    (exception) => exception.severity === "CRITICAL"
  )
    ? "CRITICAL"
    : input.schedule.state === "MISSING"
      ? "UNKNOWN"
      : orderedExceptions.length > 0
        ? "ATTENTION"
        : "HEALTHY";

  return { health, exceptions: orderedExceptions };
}
