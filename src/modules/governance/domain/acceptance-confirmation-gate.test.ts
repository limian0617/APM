import { describe, expect, it } from "vitest";

import { evaluateAcceptanceConfirmationGate } from "./acceptance-confirmation-gate";

const base = {
  factsAvailable: true,
  acceptanceType: "FAT" as const,
  reportId: "report-1",
  reportChecksum: "a".repeat(64),
  reportStatus: "READY" as const,
  confirmationId: "confirmation-1",
  confirmationChecksum: "b".repeat(64),
  confirmationDecision: "ACCEPTED" as const,
  hasUnresolvedHardIssue: false,
  reservationResidualItemIds: [] as string[],
  reservationsFullyGoverned: true
};

describe("APM-102 acceptance confirmation Gate checker", () => {
  it("hard-fails when the report or confirmation fact is unavailable", () => {
    expect(evaluateAcceptanceConfirmationGate({ ...base, factsAvailable: false }).code).toBe(
      "ACCEPTANCE_CONFIRMATION_FACTS_UNAVAILABLE"
    );
    expect(
      evaluateAcceptanceConfirmationGate({
        ...base,
        confirmationId: null,
        confirmationChecksum: null
      }).code
    ).toBe("ACCEPTANCE_CONFIRMATION_REQUIRED");
  });

  it("hard-fails a rejection and an accepted report with unresolved hard issues", () => {
    expect(
      evaluateAcceptanceConfirmationGate({ ...base, confirmationDecision: "REJECTED" }).status
    ).toBe("HARD_FAILED");
    expect(evaluateAcceptanceConfirmationGate({ ...base, hasUnresolvedHardIssue: true }).code).toBe(
      "ACCEPTANCE_HARD_ISSUE_UNRESOLVED"
    );
  });

  it("only permits an explicitly governed reservation as a warning", () => {
    expect(
      evaluateAcceptanceConfirmationGate({
        ...base,
        confirmationDecision: "ACCEPTED_WITH_RESERVATIONS",
        reservationResidualItemIds: ["residual-1"],
        reservationsFullyGoverned: true
      }).status
    ).toBe("WARNING");
    expect(
      evaluateAcceptanceConfirmationGate({
        ...base,
        confirmationDecision: "ACCEPTED_WITH_RESERVATIONS",
        reservationResidualItemIds: [],
        reservationsFullyGoverned: false
      }).code
    ).toBe("ACCEPTANCE_RESERVATION_RESIDUAL_REQUIRED");
  });

  it("returns immutable snapshot evidence for an accepted confirmation", () => {
    expect(evaluateAcceptanceConfirmationGate(base)).toMatchObject({
      status: "PASSED",
      evidence: {
        reportId: "report-1",
        reportChecksum: "a".repeat(64),
        confirmationId: "confirmation-1",
        confirmationChecksum: "b".repeat(64),
        residualItemIds: []
      }
    });
  });
});
