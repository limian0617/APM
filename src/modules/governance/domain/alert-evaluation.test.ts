import { describe, expect, it } from "vitest";

import { evaluateAlertCandidates } from "./alert-evaluation";
import { ALERT_SOURCE_TYPES } from "./alert-policy";

const now = new Date("2026-08-04T00:00:00.000Z");

describe("APM-034 alert source evaluation", () => {
  it("emits only critical tasks delayed beyond the configured whole-day threshold", () => {
    const candidates = evaluateAlertCandidates(
      { sourceType: ALERT_SOURCE_TYPES.CRITICAL_TASK_DELAY, condition: { thresholdDays: 2 } },
      now,
      {
        criticalTasks: [
          {
            id: "late-task",
            plannedFinishAt: new Date("2026-08-01T00:00:00.000Z"),
            predictedFinishAt: new Date("2026-08-04T00:00:00.000Z"),
            isCritical: true
          },
          {
            id: "non-critical",
            plannedFinishAt: new Date("2026-08-01T00:00:00.000Z"),
            predictedFinishAt: new Date("2026-08-10T00:00:00.000Z"),
            isCritical: false
          }
        ]
      }
    );

    expect(candidates).toMatchObject([{ sourceKey: "CRITICAL_TASK_DELAY:late-task", days: 3 }]);
  });

  it("keeps no-data and stale schedule freshness visible as a candidate", () => {
    expect(
      evaluateAlertCandidates(
        {
          sourceType: ALERT_SOURCE_TYPES.SCHEDULE_FORECAST_STALE,
          condition: { maximumAgeDays: 1 }
        },
        now,
        { scheduleCalculatedAt: null }
      )
    ).toMatchObject([{ sourceKey: "SCHEDULE_FORECAST_STALE:project", state: "NO_DATA" }]);
  });

  it("excludes achieved milestones and closed residuals", () => {
    const milestones = evaluateAlertCandidates(
      { sourceType: ALERT_SOURCE_TYPES.MILESTONE_OVERDUE, condition: { thresholdDays: 0 } },
      now,
      {
        milestones: [
          { id: "open", targetAt: new Date("2026-08-03T00:00:00.000Z"), status: "PENDING" },
          { id: "done", targetAt: new Date("2026-08-01T00:00:00.000Z"), status: "ACHIEVED" }
        ]
      }
    );
    const residuals = evaluateAlertCandidates(
      { sourceType: ALERT_SOURCE_TYPES.RESIDUAL_ITEM_OVERDUE, condition: {} },
      now,
      {
        residualItems: [
          { id: "open", dueAt: new Date("2026-08-03T00:00:00.000Z"), status: "OPEN" },
          { id: "closed", dueAt: new Date("2026-08-01T00:00:00.000Z"), status: "CLOSED" }
        ]
      }
    );

    expect(milestones.map((candidate) => candidate.sourceKey)).toEqual(["MILESTONE_OVERDUE:open"]);
    expect(residuals.map((candidate) => candidate.sourceKey)).toEqual([
      "RESIDUAL_ITEM_OVERDUE:open"
    ]);
  });

  it("emits each hard Gate failure with a stable source key", () => {
    expect(
      evaluateAlertCandidates(
        { sourceType: ALERT_SOURCE_TYPES.GATE_HARD_FAILURE, condition: {} },
        now,
        { gateFailures: [{ id: "check-result", message: "安全检查失败" }] }
      )
    ).toMatchObject([{ sourceKey: "GATE_HARD_FAILURE:check-result", message: "安全检查失败" }]);
  });
});
