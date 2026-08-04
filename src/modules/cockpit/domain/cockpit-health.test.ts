import { describe, expect, it } from "vitest";

import { deriveCockpitHealth } from "./cockpit-health";

const now = new Date("2026-08-05T00:00:00.000Z");

describe("APM-040 deterministic cockpit health", () => {
  it("prioritizes a hard Gate failure above every other exception", () => {
    const projection = deriveCockpitHealth({
      schedule: { state: "CURRENT", calculatedAt: now },
      hardGateFailures: [
        {
          gateInstanceId: "gate-1",
          gateCode: "G3",
          checkedAt: new Date("2026-08-04T00:00:00.000Z")
        }
      ],
      highRiskAlerts: [
        {
          alertId: "alert-1",
          ruleCode: "MILESTONE_RISK",
          observedAt: new Date("2026-08-05T00:00:00.000Z")
        }
      ],
      criticalPathDelays: [
        {
          taskId: "task-1",
          taskCode: "MECH-010",
          plannedFinishAt: new Date("2026-08-03T00:00:00.000Z"),
          predictedFinishAt: new Date("2026-08-06T00:00:00.000Z")
        }
      ],
      overdueMilestones: [
        {
          milestoneId: "milestone-1",
          milestoneCode: "M1",
          targetAt: new Date("2026-08-02T00:00:00.000Z")
        }
      ]
    });

    expect(projection.health).toBe("CRITICAL");
    expect(projection.exceptions.map((exception) => exception.kind)).toEqual([
      "HIGH_RISK_ALERT",
      "GATE_HARD_FAILURE",
      "CRITICAL_PATH_DELAY",
      "MILESTONE_OVERDUE"
    ]);
    expect(projection.exceptions[0]).toMatchObject({
      severity: "CRITICAL",
      sourceKey: "alert-1",
      drilldownPath: "/api/projects/{projectId}/alerts"
    });
  });

  it("treats a current empty exception set as healthy but missing schedule data as unknown", () => {
    expect(
      deriveCockpitHealth({
        schedule: { state: "CURRENT", calculatedAt: now },
        hardGateFailures: [],
        highRiskAlerts: [],
        criticalPathDelays: [],
        overdueMilestones: []
      })
    ).toMatchObject({ health: "HEALTHY", exceptions: [] });

    expect(
      deriveCockpitHealth({
        schedule: { state: "MISSING", calculatedAt: null },
        hardGateFailures: [],
        highRiskAlerts: [],
        criticalPathDelays: [],
        overdueMilestones: []
      })
    ).toMatchObject({
      health: "UNKNOWN",
      exceptions: [expect.objectContaining({ kind: "SCHEDULE_STALE", severity: "ATTENTION" })]
    });
  });

  it("makes failed or stale schedules actionable without escalating them to critical", () => {
    for (const state of ["FAILED", "STALE"] as const) {
      const projection = deriveCockpitHealth({
        schedule: { state, calculatedAt: now },
        hardGateFailures: [],
        highRiskAlerts: [],
        criticalPathDelays: [],
        overdueMilestones: []
      });

      expect(projection.health).toBe("ATTENTION");
      expect(projection.exceptions).toEqual([
        expect.objectContaining({
          kind: state === "FAILED" ? "SCHEDULE_FAILED" : "SCHEDULE_STALE",
          severity: "ATTENTION",
          sourceKey: "schedule"
        })
      ]);
    }
  });
});
