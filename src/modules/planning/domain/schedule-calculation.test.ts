import { describe, expect, it } from "vitest";

import {
  calculateSchedule,
  createScheduleCalendarOperations,
  ScheduleCalculationError
} from "./schedule-calculation";

const calendar = {
  timeZone: "Asia/Shanghai",
  weeklyRules: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
    dayOfWeek,
    intervals: [
      { startMinute: 480, endMinute: 720 },
      { startMinute: 780, endMinute: 1020 }
    ]
  })),
  exceptions: [
    { date: "2026-08-05", intervals: [] },
    { date: "2026-08-08", intervals: [{ startMinute: 540, endMinute: 720 }] }
  ]
};

function task(taskId: string, start: string, duration = 480) {
  return {
    taskId,
    status: "NOT_STARTED" as const,
    plannedStartAt: new Date(start),
    plannedDurationMinutes: duration,
    actualStartAt: null,
    actualFinishAt: null,
    remainingDurationMinutes: duration
  };
}

describe("APM-022 deterministic work calendar and CPM", () => {
  it("adds work minutes across lunch, holidays, weekends, and exception workdays", () => {
    const operations = createScheduleCalendarOperations(calendar);
    const start = new Date("2026-08-04T03:00:00.000Z"); // Tuesday 11:00 Asia/Shanghai
    expect(operations.addWorkingMinutes(start, 420).toString()).toBe("2026-08-06T02:00:00Z");
    expect(operations.addWorkingMinutes(new Date("2026-08-07T09:00:00.000Z"), 120).toString()).toBe(
      "2026-08-08T03:00:00Z"
    );
  });

  it("uses project timezone rules across a daylight-saving transition", () => {
    const operations = createScheduleCalendarOperations({
      timeZone: "America/New_York",
      weeklyRules: [{ dayOfWeek: 7, intervals: [{ startMinute: 60, endMinute: 240 }] }],
      exceptions: []
    });
    expect(operations.addWorkingMinutes(new Date("2026-03-08T06:00:00.000Z"), 120).toString()).toBe(
      "2026-03-08T08:00:00Z"
    );
  });

  it("calculates FS, SS, and FF constraints with positive and negative lag", () => {
    const result = calculateSchedule({
      asOf: new Date("2026-08-03T00:00:00.000Z"),
      calendar,
      tasks: [
        task("A", "2026-08-03T00:00:00.000Z"),
        task("B", "2026-08-03T00:00:00.000Z"),
        task("C", "2026-08-03T00:00:00.000Z", 240),
        task("D", "2026-08-03T00:00:00.000Z", 240)
      ],
      dependencies: [
        {
          predecessorTaskId: "A",
          successorTaskId: "B",
          dependencyType: "FS",
          lagMinutes: 60
        },
        {
          predecessorTaskId: "A",
          successorTaskId: "C",
          dependencyType: "SS",
          lagMinutes: 120
        },
        {
          predecessorTaskId: "B",
          successorTaskId: "D",
          dependencyType: "FF",
          lagMinutes: -60
        }
      ]
    });
    const byId = new Map(result.tasks.map((value) => [value.taskId, value]));
    expect(byId.get("B")!.predictedStartAt > byId.get("A")!.predictedFinishAt).toBe(true);
    expect(byId.get("C")!.predictedStartAt > byId.get("A")!.predictedStartAt).toBe(true);
    expect(byId.get("D")!.predictedFinishAt < byId.get("B")!.predictedFinishAt).toBe(true);
  });

  it("identifies critical and non-critical branches with reproducible float", () => {
    const result = calculateSchedule({
      asOf: new Date("2026-08-03T00:00:00.000Z"),
      calendar,
      tasks: [
        task("A", "2026-08-03T00:00:00.000Z", 480),
        task("B", "2026-08-03T00:00:00.000Z", 480),
        task("C", "2026-08-03T00:00:00.000Z", 240),
        task("D", "2026-08-03T00:00:00.000Z", 480)
      ],
      dependencies: [
        { predecessorTaskId: "A", successorTaskId: "B", dependencyType: "FS", lagMinutes: 0 },
        { predecessorTaskId: "A", successorTaskId: "C", dependencyType: "FS", lagMinutes: 0 },
        { predecessorTaskId: "B", successorTaskId: "D", dependencyType: "FS", lagMinutes: 0 },
        { predecessorTaskId: "C", successorTaskId: "D", dependencyType: "FS", lagMinutes: 0 }
      ]
    });
    const byId = new Map(result.tasks.map((value) => [value.taskId, value]));
    expect(["A", "B", "D"].map((id) => byId.get(id)!.isCritical)).toEqual([true, true, true]);
    expect(byId.get("C")!.isCritical).toBe(false);
    expect(byId.get("C")!.totalFloatMinutes).toBe(240);
  });

  it("anchors in-progress work at the calculation time and preserves completed facts", () => {
    const result = calculateSchedule({
      asOf: new Date("2026-08-04T00:00:00.000Z"),
      calendar,
      tasks: [
        {
          ...task("A", "2026-08-03T00:00:00.000Z"),
          status: "COMPLETED",
          actualStartAt: new Date("2026-08-03T00:00:00.000Z"),
          actualFinishAt: new Date("2026-08-03T09:00:00.000Z"),
          remainingDurationMinutes: 0
        },
        {
          ...task("B", "2026-08-03T00:00:00.000Z"),
          status: "IN_PROGRESS",
          actualStartAt: new Date("2026-08-03T00:00:00.000Z"),
          remainingDurationMinutes: 120
        }
      ],
      dependencies: []
    });
    const byId = new Map(result.tasks.map((value) => [value.taskId, value]));
    expect(byId.get("A")!.predictedFinishAt.toISOString()).toBe("2026-08-03T09:00:00.000Z");
    expect(byId.get("B")!.predictedFinishAt > new Date("2026-08-04T00:00:00.000Z")).toBe(true);
  });

  it("returns an empty result and rejects cyclic input deterministically", () => {
    expect(
      calculateSchedule({
        asOf: new Date("2026-08-03T00:00:00.000Z"),
        calendar,
        tasks: [],
        dependencies: []
      })
    ).toEqual({ projectFinishAt: null, tasks: [] });
    expect(() =>
      calculateSchedule({
        asOf: new Date("2026-08-03T00:00:00.000Z"),
        calendar,
        tasks: [task("A", "2026-08-03T00:00:00.000Z"), task("B", "2026-08-03T00:00:00.000Z")],
        dependencies: [
          { predecessorTaskId: "A", successorTaskId: "B", dependencyType: "FS", lagMinutes: 0 },
          { predecessorTaskId: "B", successorTaskId: "A", dependencyType: "FS", lagMinutes: 0 }
        ]
      })
    ).toThrowError(ScheduleCalculationError);
  });

  it("recalculates a 1000-task dependency chain within the package performance target", () => {
    const tasks = Array.from({ length: 1000 }, (_, position) =>
      task(`TASK.${position.toString().padStart(4, "0")}`, "2026-08-03T00:00:00.000Z", 1)
    );
    const dependencies = tasks.slice(1).map((current, position) => ({
      predecessorTaskId: tasks[position]!.taskId,
      successorTaskId: current.taskId,
      dependencyType: "FS" as const,
      lagMinutes: 0
    }));
    const startedAt = performance.now();
    const result = calculateSchedule({
      asOf: new Date("2026-08-03T00:00:00.000Z"),
      calendar,
      tasks,
      dependencies
    });

    expect(result.tasks).toHaveLength(1000);
    expect(performance.now() - startedAt).toBeLessThan(30_000);
  });
});
