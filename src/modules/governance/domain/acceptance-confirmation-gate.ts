export type AcceptanceConfirmationGateInput = Readonly<{
  factsAvailable: boolean;
  acceptanceType: "FAT" | "SAT";
  reportId: string | null;
  reportChecksum: string | null;
  reportStatus: "READY" | "PUBLISHED" | "GENERATING" | "FAILED" | "SUPERSEDED" | null;
  confirmationId: string | null;
  confirmationChecksum: string | null;
  confirmationDecision: "ACCEPTED" | "ACCEPTED_WITH_RESERVATIONS" | "REJECTED" | null;
  hasUnresolvedHardIssue: boolean;
  reservationResidualItemIds: readonly string[];
  reservationsFullyGoverned: boolean;
}>;

export type AcceptanceConfirmationGateResult = Readonly<{
  status: "PASSED" | "WARNING" | "HARD_FAILED";
  code: string;
  message: string;
  evidence: Readonly<{
    acceptanceType: "FAT" | "SAT";
    reportId: string | null;
    reportChecksum: string | null;
    reportStatus: string | null;
    confirmationId: string | null;
    confirmationChecksum: string | null;
    confirmationDecision: string | null;
    hasUnresolvedHardIssue: boolean;
    residualItemIds: readonly string[];
  }>;
}>;

function result(
  input: AcceptanceConfirmationGateInput,
  status: AcceptanceConfirmationGateResult["status"],
  code: string,
  message: string
): AcceptanceConfirmationGateResult {
  return {
    status,
    code,
    message,
    evidence: {
      acceptanceType: input.acceptanceType,
      reportId: input.reportId,
      reportChecksum: input.reportChecksum,
      reportStatus: input.reportStatus,
      confirmationId: input.confirmationId,
      confirmationChecksum: input.confirmationChecksum,
      confirmationDecision: input.confirmationDecision,
      hasUnresolvedHardIssue: input.hasUnresolvedHardIssue,
      residualItemIds: [...new Set(input.reservationResidualItemIds)].sort()
    }
  };
}

export function evaluateAcceptanceConfirmationGate(
  input: AcceptanceConfirmationGateInput
): AcceptanceConfirmationGateResult {
  if (!input.factsAvailable) {
    return result(
      input,
      "HARD_FAILED",
      "ACCEPTANCE_CONFIRMATION_FACTS_UNAVAILABLE",
      "未冻结可验证的客户确认事实。"
    );
  }
  if (
    !input.reportId ||
    !input.reportChecksum ||
    !["READY", "PUBLISHED"].includes(input.reportStatus ?? "")
  ) {
    return result(input, "HARD_FAILED", "ACCEPTANCE_REPORT_REQUIRED", "缺少可用的受控验收报告。");
  }
  if (!input.confirmationId || !input.confirmationChecksum || !input.confirmationDecision) {
    return result(input, "HARD_FAILED", "ACCEPTANCE_CONFIRMATION_REQUIRED", "缺少客户确认记录。");
  }
  if (input.confirmationDecision === "REJECTED") {
    return result(input, "HARD_FAILED", "ACCEPTANCE_CONFIRMATION_REJECTED", "客户已拒绝验收确认。");
  }
  if (input.hasUnresolvedHardIssue) {
    return result(
      input,
      "HARD_FAILED",
      "ACCEPTANCE_HARD_ISSUE_UNRESOLVED",
      "仍存在未闭环的验收硬问题。"
    );
  }
  if (input.confirmationDecision === "ACCEPTED_WITH_RESERVATIONS") {
    if (input.reservationResidualItemIds.length === 0 || !input.reservationsFullyGoverned) {
      return result(
        input,
        "HARD_FAILED",
        "ACCEPTANCE_RESERVATION_RESIDUAL_REQUIRED",
        "附条件确认缺少有效遗留项治理。"
      );
    }
    return result(
      input,
      "WARNING",
      "ACCEPTANCE_CONFIRMATION_RESERVATION",
      "客户附条件确认，遗留项仍需按期闭环。"
    );
  }
  return result(
    input,
    "PASSED",
    "ACCEPTANCE_CONFIRMATION_ACCEPTED",
    "客户确认和验收硬问题均满足 Gate 要求。"
  );
}
