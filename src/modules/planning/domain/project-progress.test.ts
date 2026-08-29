import { describe, expect, it } from "vitest";

import { calculateProjectProgress } from "@/modules/planning/domain/project-progress";

describe("APM-025 project workday progress", () => {
  it("aggregates completed and partial work without per-task rounding", () => {
    expect(
      calculateProjectProgress(
        [
          { status: "COMPLETED", plannedDurationMinutes: 960, remainingDurationMinutes: 99 },
          { status: "IN_PROGRESS", plannedDurationMinutes: 480, remainingDurationMinutes: 240 },
          { status: "CLOSED", plannedDurationMinutes: 960, remainingDurationMinutes: 0 }
        ],
        480
      )
    ).toEqual({
      status: "READY",
      completedWorkdays: 2.5,
      totalWorkdays: 3,
      percent: 83.33333333333334
    });
  });

  it("excludes closed work, clamps inconsistent estimates, and reports an empty denominator", () => {
    expect(
      calculateProjectProgress(
        [
          { status: "NOT_STARTED", plannedDurationMinutes: 480, remainingDurationMinutes: 960 },
          { status: "IN_PROGRESS", plannedDurationMinutes: 480, remainingDurationMinutes: -60 },
          { status: "CLOSED", plannedDurationMinutes: 480, remainingDurationMinutes: 0 }
        ],
        480
      )
    ).toEqual({ status: "READY", completedWorkdays: 1, totalWorkdays: 2, percent: 50 });
    expect(calculateProjectProgress([], 480)).toEqual({ status: "EMPTY" });
    expect(
      calculateProjectProgress(
        [{ status: "NOT_STARTED", plannedDurationMinutes: 0, remainingDurationMinutes: 0 }],
        480
      )
    ).toEqual({ status: "EMPTY" });
  });
});
