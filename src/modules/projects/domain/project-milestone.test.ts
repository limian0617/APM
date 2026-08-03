import { describe, expect, it } from "vitest";

import {
  canManuallyAchieveMilestone,
  canVoidMilestone,
  shouldAutoAchieveMilestone
} from "@/modules/projects/domain/project-milestone";

describe("APM-025 project milestone state rules", () => {
  it("automatically achieves only pending milestones with completed active task links", () => {
    expect(
      shouldAutoAchieveMilestone({
        status: "PENDING",
        links: [
          { status: "ACTIVE", taskStatus: "COMPLETED" },
          { status: "ACTIVE", taskStatus: "COMPLETED" }
        ]
      })
    ).toBe(true);
    expect(
      shouldAutoAchieveMilestone({
        status: "PENDING",
        links: [
          { status: "ACTIVE", taskStatus: "COMPLETED" },
          { status: "ACTIVE", taskStatus: "IN_PROGRESS" }
        ]
      })
    ).toBe(false);
    expect(shouldAutoAchieveMilestone({ status: "PENDING", links: [] })).toBe(false);
    expect(
      shouldAutoAchieveMilestone({
        status: "ACHIEVED",
        links: [{ status: "ACTIVE", taskStatus: "COMPLETED" }]
      })
    ).toBe(false);
  });

  it("allows manual achievement only while pending and rejects a second void", () => {
    expect(canManuallyAchieveMilestone("PENDING")).toBe(true);
    expect(canManuallyAchieveMilestone("ACHIEVED")).toBe(false);
    expect(canVoidMilestone("PENDING")).toBe(true);
    expect(canVoidMilestone("ACHIEVED")).toBe(true);
    expect(canVoidMilestone("VOID")).toBe(false);
  });
});
