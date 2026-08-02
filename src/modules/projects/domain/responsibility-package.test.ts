import { describe, expect, it } from "vitest";

import {
  buildResponsibilityPackageDefinition,
  nextResponsibilityPackageState,
  responsibilityPackageAllowedActions
} from "./responsibility-package";

function definition() {
  return {
    code: "MECH.DESIGN",
    name: " 机械设计 ",
    description: " 设计与发布 ",
    deliveryUnitId: "machine-1",
    moduleId: "module-1",
    ownerMembershipId: "member-1",
    inputs: [{ code: "REQUIREMENT", description: " 已冻结需求 " }],
    outputs: [{ code: "DRAWING", description: " 已发布图纸 " }],
    acceptanceCriteria: [{ code: "REVIEWED", description: " 评审完成 " }],
    valueWeight: 25
  };
}

describe("APM-014 responsibility package rules", () => {
  it("normalizes a non-monetary package definition", () => {
    expect(buildResponsibilityPackageDefinition(definition())).toEqual({
      ...definition(),
      name: "机械设计",
      description: "设计与发布",
      inputs: [{ code: "REQUIREMENT", description: "已冻结需求" }],
      outputs: [{ code: "DRAWING", description: "已发布图纸" }],
      acceptanceCriteria: [{ code: "REVIEWED", description: "评审完成" }]
    });
  });

  it("rejects duplicate structured item codes", () => {
    expect(() =>
      buildResponsibilityPackageDefinition({
        ...definition(),
        outputs: [
          { code: "DRAWING", description: "图纸" },
          { code: "DRAWING", description: "重复图纸" }
        ]
      })
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_RESPONSIBILITY_PACKAGE_ITEM" }));
  });

  it("rejects monetary-like range overflow and empty criteria", () => {
    expect(() =>
      buildResponsibilityPackageDefinition({ ...definition(), valueWeight: 0 })
    ).toThrowError(expect.objectContaining({ code: "INVALID_RESPONSIBILITY_PACKAGE_WEIGHT" }));
    expect(() =>
      buildResponsibilityPackageDefinition({ ...definition(), acceptanceCriteria: [] })
    ).toThrowError(expect.objectContaining({ code: "INVALID_RESPONSIBILITY_PACKAGE_CONTENT" }));
  });

  it("supports repeated submit, accept, and reopen cycles", () => {
    const submitted = nextResponsibilityPackageState("OPEN", "ACCEPTANCE_SUBMITTED", 0);
    expect(submitted).toEqual({ status: "ACCEPTANCE_PENDING", acceptanceCycle: 1 });
    const accepted = nextResponsibilityPackageState(
      submitted.status,
      "ACCEPTED",
      submitted.acceptanceCycle
    );
    expect(accepted).toEqual({ status: "ACCEPTED", acceptanceCycle: 1 });
    const reopened = nextResponsibilityPackageState(
      accepted.status,
      "REOPENED",
      accepted.acceptanceCycle
    );
    expect(reopened).toEqual({ status: "OPEN", acceptanceCycle: 1 });
    expect(nextResponsibilityPackageState(reopened.status, "ACCEPTANCE_SUBMITTED", 1)).toEqual({
      status: "ACCEPTANCE_PENDING",
      acceptanceCycle: 2
    });
  });

  it("rejects invalid transitions and exposes server actions", () => {
    expect(() => nextResponsibilityPackageState("OPEN", "ACCEPTED", 0)).toThrowError(
      expect.objectContaining({ code: "RESPONSIBILITY_PACKAGE_TRANSITION_INVALID" })
    );
    expect(() => nextResponsibilityPackageState("ACCEPTANCE_PENDING", "CLOSED", 1)).toThrowError(
      expect.objectContaining({ code: "RESPONSIBILITY_PACKAGE_TRANSITION_INVALID" })
    );
    expect(responsibilityPackageAllowedActions("OPEN")).toEqual([
      "UPDATE",
      "SUBMIT_ACCEPTANCE",
      "CLOSE"
    ]);
    expect(responsibilityPackageAllowedActions("CLOSED")).toEqual([]);
  });
});
