import { describe, expect, it } from "vitest";

import {
  ProjectMilestoneError,
  shouldInstantiateMilestoneSnapshotComponent
} from "@/modules/projects/application/milestone-service";

describe("APM-025 project milestone lifecycle service", () => {
  it("accepts only canonical MILESTONE snapshot component content for instantiation", () => {
    expect(
      shouldInstantiateMilestoneSnapshotComponent({
        componentType: "MILESTONE",
        contentJson: {
          milestones: [
            { code: "DESIGN.FREEZE", name: "设计冻结", description: "评审完成", position: 0 }
          ]
        }
      })
    ).toEqual([{ code: "DESIGN.FREEZE", name: "设计冻结", description: "评审完成", position: 0 }]);
    expect(
      shouldInstantiateMilestoneSnapshotComponent({
        componentType: "WBS",
        contentJson: { packages: [] }
      })
    ).toEqual([]);
  });

  it("exposes HTTP-mappable lifecycle errors", () => {
    const error = new ProjectMilestoneError("VERSION_CONFLICT", "里程碑版本已变化。", 409);
    expect(error).toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
  });
});
