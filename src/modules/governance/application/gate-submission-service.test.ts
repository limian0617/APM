import { describe, expect, it } from "vitest";

import {
  GateSubmissionServiceError,
  parseGateApprovalConfiguration
} from "./gate-submission-service";

describe("parseGateApprovalConfiguration", () => {
  it("requires a template-frozen approval configuration before submitting a Gate", () => {
    expect(() => parseGateApprovalConfiguration({ code: "G1" })).toThrowError(
      GateSubmissionServiceError
    );
    try {
      parseGateApprovalConfiguration({ code: "G1" });
    } catch (error) {
      expect(error).toMatchObject({ code: "GATE_APPROVER_CONFIGURATION_MISSING" });
    }
  });

  it("reads the ALL or ANY project-role selector from the immutable Gate definition", () => {
    expect(
      parseGateApprovalConfiguration({
        approval: { mode: "ANY", projectRoles: ["QUALITY", "DEPARTMENT_LEAD"] }
      })
    ).toEqual({ mode: "ANY", projectRoles: ["QUALITY", "DEPARTMENT_LEAD"] });
  });
});
