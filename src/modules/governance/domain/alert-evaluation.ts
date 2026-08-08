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
  procurementFacts?: ProcurementAlertFacts;
};

export type ProcurementAlertFacts = Readonly<{
  notOrdered?: ReadonlyArray<Readonly<{ requirementId: string; isCritical: boolean }>>;
  late?: ReadonlyArray<Readonly<{ requirementId: string; promisedOn: string; requiredOn: string }>>;
  pendingAcceptance?: ReadonlyArray<
    Readonly<{
      requirementId: string;
      arrivedQuantity: string | null;
      usableQuantity: string | null;
      assemblyWindowAt: string;
    }>
  >;
  criticalShortage?: ReadonlyArray<Readonly<{ requirementId: string; criticalGapLines: number }>>;
  changeBlocked?: ReadonlyArray<Readonly<{ requirementId: string; impact: string }>>;
  dataStale?: Readonly<{
    sourceId: string;
    inputWatermark: string | null;
    calculatedAt: string | null;
  }> | null;
}>;

export function buildProcurementChangeBlockedFacts(
  impacts: readonly Readonly<{
    id: string;
    requirementId: string;
    status: string;
    type: string;
  }>[]
): Array<{ requirementId: string; impact: string }> {
  return impacts
    .filter((impact) => impact.status === "OPEN")
    .map((impact) => ({ requirementId: impact.requirementId, impact: impact.type }))
    .sort((left, right) => left.requirementId.localeCompare(right.requirementId));
}

export type AlertCandidate = {
  sourceType?: AlertSourceType;
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
    case "PROCUREMENT_NOT_ORDERED":
      return (input.procurementFacts?.notOrdered ?? []).map((fact) => ({
        sourceType: rule.sourceType,
        sourceKey: buildAlertSourceKey(rule.sourceType, fact.requirementId),
        snapshot: { requirementId: fact.requirementId, isCritical: fact.isCritical }
      }));
    case "PROCUREMENT_LATE":
      return (input.procurementFacts?.late ?? []).map((fact) => ({
        sourceType: rule.sourceType,
        sourceKey: buildAlertSourceKey(rule.sourceType, fact.requirementId),
        snapshot: {
          requirementId: fact.requirementId,
          promisedOn: fact.promisedOn,
          requiredOn: fact.requiredOn
        }
      }));
    case "PROCUREMENT_PENDING_ACCEPTANCE":
      return (input.procurementFacts?.pendingAcceptance ?? []).map((fact) => ({
        sourceType: rule.sourceType,
        sourceKey: buildAlertSourceKey(rule.sourceType, fact.requirementId),
        snapshot: {
          requirementId: fact.requirementId,
          arrivedQuantity: fact.arrivedQuantity,
          usableQuantity: fact.usableQuantity,
          assemblyWindowAt: fact.assemblyWindowAt
        }
      }));
    case "PROCUREMENT_CRITICAL_SHORTAGE":
      return (input.procurementFacts?.criticalShortage ?? []).map((fact) => ({
        sourceType: rule.sourceType,
        sourceKey: buildAlertSourceKey(rule.sourceType, fact.requirementId),
        snapshot: {
          requirementId: fact.requirementId,
          criticalGapLines: fact.criticalGapLines
        }
      }));
    case "PROCUREMENT_CHANGE_BLOCKED":
      return (input.procurementFacts?.changeBlocked ?? []).map((fact) => ({
        sourceType: rule.sourceType,
        sourceKey: buildAlertSourceKey(rule.sourceType, fact.requirementId),
        snapshot: { requirementId: fact.requirementId, impact: fact.impact }
      }));
    case "PROCUREMENT_DATA_STALE": {
      const fact = input.procurementFacts?.dataStale;
      if (!fact) return [];
      return [
        {
          sourceType: rule.sourceType,
          sourceKey: buildAlertSourceKey(rule.sourceType, fact.sourceId),
          snapshot: {
            inputWatermark: fact.inputWatermark,
            calculatedAt: fact.calculatedAt
          }
        }
      ];
    }
  }

  return [];
}
