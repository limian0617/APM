import { describe, expect, it } from "vitest";

import {
  GateSubmissionError,
  evaluateGateSubmissionDecision,
  resolveGateSubmissionApprovers
} from "./gate-submission";

describe("resolveGateSubmissionApprovers", () => {
  it("freezes each eligible user once with every matching project role", () => {
    expect(
      resolveGateSubmissionApprovers({
        approverProjectRoles: ["QUALITY", "DEPARTMENT_LEAD"],
        activeMembers: [
          { membershipId: "member-quality", userId: "quality-user", projectRole: "QUALITY" },
          {
            membershipId: "member-lead",
            userId: "quality-user",
            projectRole: "DEPARTMENT_LEAD"
          },
          { membershipId: "member-engineer", userId: "engineer-user", projectRole: "ENGINEER" }
        ]
      })
    ).toEqual([
      {
        userId: "quality-user",
        membershipIds: ["member-lead", "member-quality"],
        projectRoles: ["DEPARTMENT_LEAD", "QUALITY"]
      }
    ]);
  });

  it("rejects a submission when the configured roles resolve no active project member", () => {
    const resolve = () =>
      resolveGateSubmissionApprovers({
        approverProjectRoles: ["QUALITY"],
        activeMembers: [{ membershipId: "member-1", userId: "engineer", projectRole: "ENGINEER" }]
      });

    expect(resolve).toThrowError(GateSubmissionError);
    try {
      resolve();
    } catch (error) {
      expect(error).toMatchObject({
        code: "GATE_APPROVER_EMPTY"
      } satisfies Partial<GateSubmissionError>);
    }
  });
});

describe("evaluateGateSubmissionDecision", () => {
  it("requires every frozen approver for ALL mode", () => {
    expect(
      evaluateGateSubmissionDecision({
        approvalMode: "ALL",
        approverUserIds: ["quality", "lead"],
        decisions: [{ userId: "quality", decision: "APPROVED" }]
      })
    ).toBe("PENDING");
    expect(
      evaluateGateSubmissionDecision({
        approvalMode: "ALL",
        approverUserIds: ["quality", "lead"],
        decisions: [
          { userId: "quality", decision: "APPROVED" },
          { userId: "lead", decision: "APPROVED" }
        ]
      })
    ).toBe("APPROVED");
  });

  it("approves on the first approval for ANY mode but always rejects on a rejection", () => {
    expect(
      evaluateGateSubmissionDecision({
        approvalMode: "ANY",
        approverUserIds: ["quality", "lead"],
        decisions: [{ userId: "quality", decision: "APPROVED" }]
      })
    ).toBe("APPROVED");
    expect(
      evaluateGateSubmissionDecision({
        approvalMode: "ANY",
        approverUserIds: ["quality", "lead"],
        decisions: [{ userId: "lead", decision: "REJECTED" }]
      })
    ).toBe("REJECTED");
  });
});
