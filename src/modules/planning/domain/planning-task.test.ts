import { describe, expect, it } from "vitest";

import {
  assertWbsParent,
  buildPlanningTaskDefinition,
  buildPlanningTaskProgress,
  buildWbsNodeDefinition,
  planningTaskAllowedActions,
  PlanningError
} from "./planning-task";

function taskDefinition() {
  return {
    code: "MECH.DESIGN.01",
    name: "机械详细设计",
    description: "输出受控机械图纸",
    wbsNodeId: "wbs-design",
    responsibilityPackageId: "package-design",
    deliveryUnitId: "machine-01",
    moduleId: "module-01",
    ownerMembershipId: "membership-owner",
    position: 0,
    plannedStartAt: "2026-08-03T00:00:00.000Z",
    plannedFinishAt: "2026-08-10T00:00:00.000Z",
    plannedDurationMinutes: 2400,
    weight: 25
  };
}

describe("APM-020 planning rules", () => {
  it("normalizes WBS definitions and rejects self-parenting", () => {
    expect(
      buildWbsNodeDefinition({
        code: "DESIGN",
        name: "  详细设计  ",
        description: null,
        parentId: null,
        position: 0
      })
    ).toEqual({
      code: "DESIGN",
      name: "详细设计",
      description: null,
      parentId: null,
      position: 0
    });
    expect(() => assertWbsParent("same", "same")).toThrowError(PlanningError);
  });

  it("builds a calendar-neutral task definition with integer-minute duration", () => {
    expect(buildPlanningTaskDefinition(taskDefinition())).toMatchObject({
      code: "MECH.DESIGN.01",
      plannedDurationMinutes: 2400,
      weight: 25
    });
  });

  it("rejects invalid task ranges, durations, weights, and codes", () => {
    expect(() =>
      buildPlanningTaskDefinition({
        ...taskDefinition(),
        plannedFinishAt: taskDefinition().plannedStartAt
      })
    ).toThrowError(PlanningError);
    expect(() =>
      buildPlanningTaskDefinition({ ...taskDefinition(), plannedDurationMinutes: 0 })
    ).toThrowError(PlanningError);
    expect(() => buildPlanningTaskDefinition({ ...taskDefinition(), weight: 0 })).toThrowError(
      PlanningError
    );
    expect(() => buildPlanningTaskDefinition({ ...taskDefinition(), code: "bad" })).toThrowError(
      PlanningError
    );
  });

  it("derives not-started and in-progress states from execution fields", () => {
    expect(
      buildPlanningTaskProgress({
        plannedStartAt: taskDefinition().plannedStartAt,
        remainingDurationMinutes: 2400,
        forecastFinishAt: taskDefinition().plannedFinishAt
      })
    ).toMatchObject({ status: "NOT_STARTED", actualStartAt: null });
    expect(
      buildPlanningTaskProgress({
        plannedStartAt: taskDefinition().plannedStartAt,
        actualStartAt: "2026-08-04T00:00:00.000Z",
        remainingDurationMinutes: 1200,
        forecastFinishAt: "2026-08-11T00:00:00.000Z"
      })
    ).toMatchObject({ status: "IN_PROGRESS", remainingDurationMinutes: 1200 });
  });

  it("derives completion and freezes forecast at actual finish", () => {
    const completed = buildPlanningTaskProgress({
      plannedStartAt: taskDefinition().plannedStartAt,
      actualStartAt: "2026-08-04T00:00:00.000Z",
      actualFinishAt: "2026-08-09T00:00:00.000Z",
      remainingDurationMinutes: 0,
      forecastFinishAt: "2026-08-12T00:00:00.000Z"
    });
    expect(completed).toMatchObject({
      status: "COMPLETED",
      remainingDurationMinutes: 0,
      forecastFinishAt: new Date("2026-08-09T00:00:00.000Z")
    });
  });

  it("rejects contradictory execution fields", () => {
    expect(() =>
      buildPlanningTaskProgress({
        plannedStartAt: taskDefinition().plannedStartAt,
        actualFinishAt: "2026-08-09T00:00:00.000Z",
        remainingDurationMinutes: 0
      })
    ).toThrowError(PlanningError);
    expect(() =>
      buildPlanningTaskProgress({
        plannedStartAt: taskDefinition().plannedStartAt,
        actualStartAt: "2026-08-04T00:00:00.000Z",
        remainingDurationMinutes: 0,
        forecastFinishAt: "2026-08-11T00:00:00.000Z"
      })
    ).toThrowError(PlanningError);
  });

  it("exposes actions from server-owned task state", () => {
    expect(planningTaskAllowedActions("NOT_STARTED")).toEqual([
      "UPDATE_PLAN",
      "UPDATE_PROGRESS",
      "CLOSE"
    ]);
    expect(planningTaskAllowedActions("IN_PROGRESS")).toEqual(["UPDATE_PROGRESS", "CLOSE"]);
    expect(planningTaskAllowedActions("COMPLETED")).toEqual(["UPDATE_PROGRESS", "CLOSE"]);
    expect(planningTaskAllowedActions("CLOSED")).toEqual([]);
  });
});
