import { buildAlertSourceKey, type AlertSourceType } from "./alert-policy";

const DAY_MS = 24 * 60 * 60 * 1000;

type Rule = {
  sourceType: AlertSourceType;
  condition: { thresholdDays?: number; maximumAgeDays?: number };
};

type EvaluationInput = {
  scheduleCalculatedAt?: Date | null;
  criticalTasks?: Array<{
    id: string;
    plannedFinishAt: Date;
    predictedFinishAt: Date;
    isCritical: boolean;
  }>;
  milestones?: Array<{ id: string; targetAt: Date | null; status: string }>;
  gateFailures?: Array<{ id: string; message: string }>;
  residualItems?: Array<{ id: string; dueAt: Date; status: string }>;
};

export type AlertCandidate = {
  sourceKey: string;
  snapshot: Record<string, unknown>;
  days?: number;
  state?: "NO_DATA" | "STALE";
  message?: string;
};

function daysAfter(later: Date, earlier: Date): number {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / DAY_MS));
}

export function evaluateAlertCandidates(
  rule: Rule,
  now: Date,
  input: EvaluationInput
): AlertCandidate[] {
  switch (rule.sourceType) {
    case "SCHEDULE_FORECAST_STALE": {
      const calculatedAt = input.scheduleCalculatedAt ?? null;
      if (!calculatedAt) {
        return [
          {
            sourceKey: buildAlertSourceKey(rule.sourceType, "project"),
            state: "NO_DATA",
            snapshot: {}
          }
        ];
      }
      const days = daysAfter(now, calculatedAt);
      return days > (rule.condition.maximumAgeDays ?? 0)
        ? [
            {
              sourceKey: buildAlertSourceKey(rule.sourceType, "project"),
              state: "STALE",
              days,
              snapshot: {
                calculatedAt: calculatedAt.toISOString(),
                maximumAgeDays: rule.condition.maximumAgeDays
              }
            }
          ]
        : [];
    }
    case "CRITICAL_TASK_DELAY":
      return (input.criticalTasks ?? []).flatMap((task) => {
        const days = daysAfter(task.predictedFinishAt, task.plannedFinishAt);
        if (!task.isCritical || days <= (rule.condition.thresholdDays ?? 0)) return [];
        return [
          {
            sourceKey: buildAlertSourceKey(rule.sourceType, task.id),
            days,
            snapshot: {
              taskId: task.id,
              plannedFinishAt: task.plannedFinishAt.toISOString(),
              predictedFinishAt: task.predictedFinishAt.toISOString(),
              delayDays: days
            }
          }
        ];
      });
    case "MILESTONE_OVERDUE":
      return (input.milestones ?? []).flatMap((milestone) => {
        if (milestone.status !== "PENDING" || !milestone.targetAt) return [];
        const days = daysAfter(now, milestone.targetAt);
        if (days <= (rule.condition.thresholdDays ?? 0)) return [];
        return [
          {
            sourceKey: buildAlertSourceKey(rule.sourceType, milestone.id),
            days,
            snapshot: {
              milestoneId: milestone.id,
              targetAt: milestone.targetAt.toISOString(),
              overdueDays: days
            }
          }
        ];
      });
    case "GATE_HARD_FAILURE":
      return (input.gateFailures ?? []).map((failure) => ({
        sourceKey: buildAlertSourceKey(rule.sourceType, failure.id),
        message: failure.message,
        snapshot: { gateCheckResultId: failure.id, message: failure.message }
      }));
    case "RESIDUAL_ITEM_OVERDUE":
      return (input.residualItems ?? []).flatMap((item) => {
        if (item.status === "CLOSED") return [];
        const days = daysAfter(now, item.dueAt);
        if (days === 0) return [];
        return [
          {
            sourceKey: buildAlertSourceKey(rule.sourceType, item.id),
            days,
            snapshot: {
              residualItemId: item.id,
              dueAt: item.dueAt.toISOString(),
              overdueDays: days
            }
          }
        ];
      });
  }
}
