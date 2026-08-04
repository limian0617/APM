import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS, AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";

import {
  GateConditionalReleaseError,
  nextResidualStatus,
  validateConditionalReleaseEligibility,
  validateResidualItemInput
} from "./gate-conditional-release";

const validInput = {
  title: "补充安全防护照片",
  ownerMembershipId: "member-owner",
  verifierMembershipId: "member-verifier",
  dueAt: new Date("2026-08-10T00:00:00.000Z"),
  evidence: "FAT 记录 12",
  escalationRule: "逾期后升级给 PM"
};

describe("APM-033 residual item rules", () => {
  it("requires complete residual ownership, deadline, evidence and escalation facts", () => {
    expect(validateResidualItemInput(validInput)).toEqual(validInput);

    for (const [field, code] of [
      ["title", "RESIDUAL_TITLE_REQUIRED"],
      ["ownerMembershipId", "RESIDUAL_OWNER_REQUIRED"],
      ["verifierMembershipId", "RESIDUAL_VERIFIER_REQUIRED"],
      ["evidence", "RESIDUAL_EVIDENCE_REQUIRED"],
      ["escalationRule", "RESIDUAL_ESCALATION_REQUIRED"]
    ] as const) {
      try {
        validateResidualItemInput({ ...validInput, [field]: "" });
        throw new Error("Expected input validation to fail.");
      } catch (error) {
        expect(error).toMatchObject({ code } satisfies Partial<GateConditionalReleaseError>);
      }
    }
  });

  it("allows only owner processing and verifier closure transitions", () => {
    expect(nextResidualStatus("OPEN", "START")).toBe("IN_PROGRESS");
    expect(nextResidualStatus("OPEN", "SUBMIT_VERIFICATION")).toBe("AWAITING_VERIFICATION");
    expect(nextResidualStatus("IN_PROGRESS", "SUBMIT_VERIFICATION")).toBe("AWAITING_VERIFICATION");
    expect(nextResidualStatus("AWAITING_VERIFICATION", "VERIFY")).toBe("CLOSED");
    expect(nextResidualStatus("AWAITING_VERIFICATION", "RETURN")).toBe("IN_PROGRESS");

    try {
      nextResidualStatus("OPEN", "VERIFY");
      throw new Error("Expected an invalid transition.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "RESIDUAL_TRANSITION_INVALID"
      } satisfies Partial<GateConditionalReleaseError>);
    }
  });

  it("requires an approved, non-blocked Gate and an active frozen approver", () => {
    expect(() =>
      validateConditionalReleaseEligibility({
        submissionStatus: "APPROVED",
        hasHardFailedCheck: true,
        actorIsFrozenApprover: true,
        actorIsActiveProjectMember: true,
        targetStageStatus: "AWAITING_GATE"
      })
    ).toThrow("Conditional release cannot use a Gate submission with hard failures");

    expect(() =>
      validateConditionalReleaseEligibility({
        submissionStatus: "APPROVED",
        hasHardFailedCheck: false,
        actorIsFrozenApprover: false,
        actorIsActiveProjectMember: true,
        targetStageStatus: "AWAITING_GATE"
      })
    ).toThrow("Only an active frozen Gate approver");

    expect(() =>
      validateConditionalReleaseEligibility({
        submissionStatus: "APPROVED",
        hasHardFailedCheck: false,
        actorIsFrozenApprover: true,
        actorIsActiveProjectMember: true,
        targetStageStatus: "AWAITING_GATE"
      })
    ).not.toThrow();
  });

  it("uses stable audit vocabulary for conditional release and residual facts", () => {
    expect(AUDIT_ACTIONS.GATE_CONDITIONALLY_RELEASED).toBe("GATE_CONDITIONALLY_RELEASED");
    expect(AUDIT_ACTIONS.RESIDUAL_ITEM_VERIFIED).toBe("RESIDUAL_ITEM_VERIFIED");
    expect(AUDIT_OBJECT_TYPES.GATE_CONDITIONAL_RELEASE).toBe("GATE_CONDITIONAL_RELEASE");
    expect(AUDIT_OBJECT_TYPES.RESIDUAL_ITEM).toBe("RESIDUAL_ITEM");
  });
});
