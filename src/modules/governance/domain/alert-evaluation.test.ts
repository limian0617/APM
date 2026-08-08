import { describe, expect, it } from "vitest";

import { buildProcurementChangeBlockedFacts, evaluateAlertCandidates } from "./alert-evaluation";
import { ALERT_SOURCE_TYPES } from "./alert-policy";

const now = new Date("2026-08-04T00:00:00.000Z");

describe("APM-034 alert source evaluation", () => {
  it("builds procurement change blockers only from open impact facts", () => {
    expect(
      buildProcurementChangeBlockedFacts([
        { id: "impact-open", requirementId: "requirement-1", status: "OPEN", type: "REVISED" },
        {
          id: "impact-resolved",
          requirementId: "requirement-2",
          status: "RESOLVED",
          type: "CANCELED"
        }
      ])
    ).toEqual([{ requirementId: "requirement-1", impact: "REVISED" }]);
  });

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

  it("emits stable candidates for all six procurement exception sources", () => {
    const procurementFacts = {
      notOrdered: [{ requirementId: "requirement-not-ordered", isCritical: true }],
      late: [
        {
          requirementId: "requirement-late",
          promisedOn: "2026-08-01T00:00:00.000Z",
          requiredOn: "2026-07-30T00:00:00.000Z"
        }
      ],
      pendingAcceptance: [
        {
          requirementId: "requirement-pending-acceptance",
          arrivedQuantity: "10",
          usableQuantity: "0",
          assemblyWindowAt: "2026-08-04T00:00:00.000Z"
        }
      ],
      criticalShortage: [{ requirementId: "requirement-critical", criticalGapLines: 1 }],
      changeBlocked: [{ requirementId: "requirement-change", impact: "ORDERED" }],
      dataStale: {
        sourceId: "project",
        inputWatermark: "watermark-1",
        calculatedAt: "2026-08-01T00:00:00.000Z"
      }
    };
    const sourceTypes = [
      ALERT_SOURCE_TYPES.PROCUREMENT_NOT_ORDERED,
      ALERT_SOURCE_TYPES.PROCUREMENT_LATE,
      ALERT_SOURCE_TYPES.PROCUREMENT_PENDING_ACCEPTANCE,
      ALERT_SOURCE_TYPES.PROCUREMENT_CRITICAL_SHORTAGE,
      ALERT_SOURCE_TYPES.PROCUREMENT_CHANGE_BLOCKED,
      ALERT_SOURCE_TYPES.PROCUREMENT_DATA_STALE
    ] as const;

    const candidates = sourceTypes.flatMap((sourceType) =>
      evaluateAlertCandidates({ sourceType, condition: {} }, now, { procurementFacts })
    );

    expect(candidates.every((candidate) => typeof candidate.sourceType === "string")).toBe(true);
    expect(candidates).toMatchObject([
      {
        sourceType: ALERT_SOURCE_TYPES.PROCUREMENT_NOT_ORDERED,
        sourceKey: "PROCUREMENT_NOT_ORDERED:requirement-not-ordered",
        snapshot: { requirementId: "requirement-not-ordered", isCritical: true }
      },
      {
        sourceType: ALERT_SOURCE_TYPES.PROCUREMENT_LATE,
        sourceKey: "PROCUREMENT_LATE:requirement-late",
        snapshot: { requirementId: "requirement-late", requiredOn: "2026-07-30T00:00:00.000Z" }
      },
      {
        sourceType: ALERT_SOURCE_TYPES.PROCUREMENT_PENDING_ACCEPTANCE,
        sourceKey: "PROCUREMENT_PENDING_ACCEPTANCE:requirement-pending-acceptance",
        snapshot: { requirementId: "requirement-pending-acceptance", arrivedQuantity: "10" }
      },
      {
        sourceType: ALERT_SOURCE_TYPES.PROCUREMENT_CRITICAL_SHORTAGE,
        sourceKey: "PROCUREMENT_CRITICAL_SHORTAGE:requirement-critical",
        snapshot: { requirementId: "requirement-critical", criticalGapLines: 1 }
      },
      {
        sourceType: ALERT_SOURCE_TYPES.PROCUREMENT_CHANGE_BLOCKED,
        sourceKey: "PROCUREMENT_CHANGE_BLOCKED:requirement-change",
        snapshot: { requirementId: "requirement-change", impact: "ORDERED" }
      },
      {
        sourceType: ALERT_SOURCE_TYPES.PROCUREMENT_DATA_STALE,
        sourceKey: "PROCUREMENT_DATA_STALE:project",
        snapshot: { inputWatermark: "watermark-1" }
      }
    ]);
  });
});
