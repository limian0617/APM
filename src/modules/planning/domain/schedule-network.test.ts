import { describe, expect, it } from "vitest";

import { PlanningError } from "./planning-task";
import {
  assertDependencyGraphAcyclic,
  buildProjectCalendarRules,
  buildTaskDependencyDefinition
} from "./schedule-network";

function calendarRules() {
  return {
    name: "项目标准工作日历",
    timeZone: "Asia/Shanghai",
    weeklyRules: [
      {
        dayOfWeek: 2,
        intervals: [
          { startMinute: 780, endMinute: 1020 },
          { startMinute: 480, endMinute: 720 }
        ]
      },
      { dayOfWeek: 1, intervals: [{ startMinute: 480, endMinute: 1020 }] }
    ],
    exceptions: [
      { date: "2026-10-02", intervals: [{ startMinute: 540, endMinute: 720 }] },
      { date: "2026-10-01", intervals: [] }
    ]
  };
}

describe("APM-021 work calendar and dependency rules", () => {
  it("canonicalizes weekly rules and exceptions with a stable checksum", () => {
    const first = buildProjectCalendarRules(calendarRules());
    const second = buildProjectCalendarRules({
      ...calendarRules(),
      weeklyRules: [...calendarRules().weeklyRules].reverse(),
      exceptions: [...calendarRules().exceptions].reverse()
    });
    expect(first.weeklyRules.map(({ dayOfWeek }) => dayOfWeek)).toEqual([1, 2]);
    expect(first.weeklyRules[1]!.intervals[0]).toEqual({ startMinute: 480, endMinute: 720 });
    expect(first.exceptions.map(({ date }) => date)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(first.checksum).toBe(second.checksum);
  });

  it("rejects invalid IANA time zones and impossible exception dates", () => {
    expect(() =>
      buildProjectCalendarRules({ ...calendarRules(), timeZone: "Mars/Factory" })
    ).toThrowError(PlanningError);
    expect(() =>
      buildProjectCalendarRules({
        ...calendarRules(),
        exceptions: [{ date: "2026-02-30", intervals: [] }]
      })
    ).toThrowError(PlanningError);
  });

  it("rejects duplicate weekdays, dates, and overlapping work intervals", () => {
    expect(() =>
      buildProjectCalendarRules({
        ...calendarRules(),
        weeklyRules: [calendarRules().weeklyRules[0], calendarRules().weeklyRules[0]]
      })
    ).toThrowError(PlanningError);
    expect(() =>
      buildProjectCalendarRules({
        ...calendarRules(),
        exceptions: [calendarRules().exceptions[0], calendarRules().exceptions[0]]
      })
    ).toThrowError(PlanningError);
    expect(() =>
      buildProjectCalendarRules({
        ...calendarRules(),
        weeklyRules: [
          {
            dayOfWeek: 1,
            intervals: [
              { startMinute: 480, endMinute: 720 },
              { startMinute: 700, endMinute: 900 }
            ]
          }
        ]
      })
    ).toThrowError(PlanningError);
  });

  it("accepts FS, SS, and FF with bounded positive or negative lag", () => {
    for (const dependencyType of ["FS", "SS", "FF"] as const) {
      expect(
        buildTaskDependencyDefinition({
          predecessorTaskId: "task-a",
          successorTaskId: "task-b",
          dependencyType,
          lagMinutes: dependencyType === "SS" ? -480 : 480
        })
      ).toMatchObject({ dependencyType });
    }
  });

  it("rejects self dependencies, unknown types, and out-of-range lag", () => {
    expect(() =>
      buildTaskDependencyDefinition({
        predecessorTaskId: "task-a",
        successorTaskId: "task-a",
        dependencyType: "FS",
        lagMinutes: 0
      })
    ).toThrowError(PlanningError);
    expect(() =>
      buildTaskDependencyDefinition({
        predecessorTaskId: "task-a",
        successorTaskId: "task-b",
        dependencyType: "SF",
        lagMinutes: 0
      })
    ).toThrowError(PlanningError);
    expect(() =>
      buildTaskDependencyDefinition({
        predecessorTaskId: "task-a",
        successorTaskId: "task-b",
        dependencyType: "FS",
        lagMinutes: 5_256_001
      })
    ).toThrowError(PlanningError);
  });

  it("accepts an acyclic graph", () => {
    expect(() =>
      assertDependencyGraphAcyclic([{ predecessorTaskId: "task-a", successorTaskId: "task-b" }], {
        predecessorTaskId: "task-b",
        successorTaskId: "task-c"
      })
    ).not.toThrow();
  });

  it("rejects direct and transitive dependency cycles", () => {
    expect(() =>
      assertDependencyGraphAcyclic([{ predecessorTaskId: "task-a", successorTaskId: "task-b" }], {
        predecessorTaskId: "task-b",
        successorTaskId: "task-a"
      })
    ).toThrowError(PlanningError);
    expect(() =>
      assertDependencyGraphAcyclic(
        [
          { predecessorTaskId: "task-a", successorTaskId: "task-b" },
          { predecessorTaskId: "task-b", successorTaskId: "task-c" }
        ],
        { predecessorTaskId: "task-c", successorTaskId: "task-a" }
      )
    ).toThrowError(PlanningError);
  });
});
