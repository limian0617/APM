export type AcceptanceIssueCategory =
  "SAFETY" | "FUNCTION" | "PERFORMANCE" | "APPEARANCE" | "DELIVERY_COMPLETENESS";

export type AcceptanceIssueSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AcceptanceIssueStatus =
  "PENDING_ACCEPTANCE" | "ANALYZING" | "PROCESSING" | "PENDING_VERIFICATION" | "CLOSED";

export type AcceptanceFailureRevision = Readonly<{
  projectId: string;
  batchId: string;
  resultId: string;
  revisionId: string;
  acceptanceType: "FAT" | "SAT";
  decision: "PASS" | "FAIL" | "NA";
}>;

export type AcceptanceIssueFact = Readonly<{
  issueId: string;
  category: AcceptanceIssueCategory;
  severity: AcceptanceIssueSeverity;
  status: AcceptanceIssueStatus;
  ownerMembershipId: string | null;
  verifierMembershipId: string | null;
  dueDate: string | null;
  verificationPlan: string | null;
}>;

export class AcceptanceIssuePolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "AcceptanceIssuePolicyError";
  }
}

export function assertFailureRevisionLink(input: {
  projectId: string;
  expectedBatchId: string;
  failure: AcceptanceFailureRevision | null;
}): void {
  if (!input.failure) {
    throw new AcceptanceIssuePolicyError(
      "ACCEPTANCE_FAILURE_REVISION_NOT_FOUND",
      "失败结果修订不存在或不可访问。",
      404
    );
  }
  if (input.failure.projectId !== input.projectId) {
    throw new AcceptanceIssuePolicyError(
      "ACCEPTANCE_FAILURE_PROJECT_MISMATCH",
      "失败结果不属于当前项目。",
      404
    );
  }
  if (input.failure.batchId !== input.expectedBatchId) {
    throw new AcceptanceIssuePolicyError(
      "ACCEPTANCE_FAILURE_BATCH_MISMATCH",
      "失败结果不属于当前验收批次。",
      409
    );
  }
  if (input.failure.decision !== "FAIL") {
    throw new AcceptanceIssuePolicyError(
      "ACCEPTANCE_FAILURE_DECISION_REQUIRED",
      "只有 FAIL 结果修订可以关联统一问题。",
      422
    );
  }
}

export type AcceptanceIssueGateClassification = Readonly<{
  status: "HARD_FAILED" | "WARNING" | "PASSED";
  code: string;
  message: string;
}>;

export function classifyAcceptanceIssue(
  issue: AcceptanceIssueFact
): AcceptanceIssueGateClassification {
  if (issue.status === "CLOSED") {
    return { status: "PASSED", code: "ACCEPTANCE_ISSUE_CLOSED", message: "问题已关闭。" };
  }
  if (
    !issue.ownerMembershipId ||
    !issue.verifierMembershipId ||
    !issue.dueDate ||
    !issue.verificationPlan ||
    issue.category === "SAFETY" ||
    issue.category === "FUNCTION" ||
    issue.severity === "HIGH" ||
    issue.severity === "CRITICAL"
  ) {
    return {
      status: "HARD_FAILED",
      code: "ACCEPTANCE_ISSUE_HARD_FAILED",
      message: "存在未关闭的严重验收问题或不完整的治理事实。"
    };
  }
  if (
    (issue.category === "PERFORMANCE" ||
      issue.category === "APPEARANCE" ||
      issue.category === "DELIVERY_COMPLETENESS") &&
    (issue.severity === "LOW" || issue.severity === "MEDIUM")
  ) {
    return {
      status: "WARNING",
      code: "ACCEPTANCE_ISSUE_WARNING",
      message: "存在具备责任与复测计划的轻微验收问题。"
    };
  }
  return {
    status: "HARD_FAILED",
    code: "ACCEPTANCE_ISSUE_FACT_INVALID",
    message: "验收问题事实不可验证。"
  };
}

export function assertResidualCanClose(input: {
  issueStatus: AcceptanceIssueStatus;
  retestPass: boolean;
}): void {
  if (input.issueStatus !== "CLOSED") {
    throw new AcceptanceIssuePolicyError("RESIDUAL_ISSUE_NOT_CLOSED", "关联问题必须先关闭。", 409);
  }
  if (!input.retestPass) {
    throw new AcceptanceIssuePolicyError(
      "RESIDUAL_RETEST_PASS_REQUIRED",
      "必须存在锁定重测批次的 PASS 结果。",
      409
    );
  }
}
