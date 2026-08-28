import {
  classifyAcceptanceIssue,
  type AcceptanceIssueFact,
  type AcceptanceIssueGateClassification
} from "@/modules/issues/domain/acceptance-issue-policy";

export type AcceptanceGateResultDecision = "PASS" | "FAIL" | "NA" | null;

export type AcceptanceIssueGateInput = Readonly<{
  factsAvailable: boolean;
  acceptanceType?: "FAT" | "SAT";
  lockedBatchId?: string | null;
  lockedBatchChain?: readonly string[];
  templateVersionId?: string | null;
  templateChecksum?: string | null;
  sourceChecksum: string;
  requiredResultMissing: boolean;
  results: ReadonlyArray<{
    resultRevisionId: string;
    itemCode: string;
    decision: AcceptanceGateResultDecision;
    issueIds: readonly string[];
  }>;
  issues: readonly AcceptanceIssueFact[];
  retestPassRevisionIds: readonly string[];
}>;

export type AcceptanceIssueGateResult = Readonly<{
  status: "PASSED" | "WARNING" | "HARD_FAILED";
  code: string;
  message: string;
  evidence: Readonly<{
    acceptanceType?: "FAT" | "SAT";
    lockedBatchId?: string | null;
    lockedBatchChain?: readonly string[];
    templateVersionId?: string | null;
    templateChecksum?: string | null;
    sourceChecksum: string;
    resultRevisionIds: readonly string[];
    issueIds: readonly string[];
    warnings: readonly string[];
    retestPassRevisionIds: readonly string[];
    failureLinks: readonly Readonly<{ resultRevisionId: string; issueIds: readonly string[] }>[];
    issueFacts: readonly AcceptanceIssueFact[];
  }>;
}>;

function evidence(input: AcceptanceIssueGateInput, warnings: readonly string[]) {
  return {
    ...(input.acceptanceType ? { acceptanceType: input.acceptanceType } : {}),
    ...(input.lockedBatchId !== undefined ? { lockedBatchId: input.lockedBatchId } : {}),
    ...(input.lockedBatchChain ? { lockedBatchChain: [...input.lockedBatchChain] } : {}),
    ...(input.templateVersionId !== undefined
      ? { templateVersionId: input.templateVersionId }
      : {}),
    ...(input.templateChecksum !== undefined ? { templateChecksum: input.templateChecksum } : {}),
    sourceChecksum: input.sourceChecksum,
    resultRevisionIds: input.results.map((result) => result.resultRevisionId).sort(),
    issueIds: input.issues.map((issue) => issue.issueId).sort(),
    warnings: [...warnings].sort(),
    retestPassRevisionIds: [...input.retestPassRevisionIds].sort(),
    failureLinks: input.results
      .filter((result) => result.decision === "FAIL")
      .map((result) => ({
        resultRevisionId: result.resultRevisionId,
        issueIds: [...result.issueIds].sort()
      }))
      .sort((left, right) => left.resultRevisionId.localeCompare(right.resultRevisionId)),
    issueFacts: [...input.issues].sort((left, right) => left.issueId.localeCompare(right.issueId))
  };
}

function hard(
  input: AcceptanceIssueGateInput,
  code: string,
  message: string
): AcceptanceIssueGateResult {
  return { status: "HARD_FAILED", code, message, evidence: evidence(input, []) };
}

function classificationCode(classification: AcceptanceIssueGateClassification) {
  return classification.code;
}

export function evaluateAcceptanceIssueGate(
  input: AcceptanceIssueGateInput
): AcceptanceIssueGateResult {
  if (!input.factsAvailable) {
    return hard(input, "ACCEPTANCE_FACTS_UNAVAILABLE", "验收或问题事实不可用，Gate 默认失败。");
  }
  if (input.requiredResultMissing) {
    return hard(input, "ACCEPTANCE_REQUIRED_RESULT_MISSING", "验收必测项缺少有效结果。");
  }
  const issueById = new Map(input.issues.map((issue) => [issue.issueId, issue]));
  const warnings: string[] = [];
  for (const result of input.results) {
    if (result.decision !== "FAIL") continue;
    if (result.issueIds.length === 0) {
      return hard(input, "ACCEPTANCE_FAIL_ISSUE_UNLINKED", "存在未关联统一问题的 FAIL 结果修订。");
    }
    for (const issueId of result.issueIds) {
      const issue = issueById.get(issueId);
      if (!issue) {
        return hard(input, "ACCEPTANCE_ISSUE_FACT_UNAVAILABLE", "失败结果关联的问题事实不可验证。");
      }
      const classification = classifyAcceptanceIssue(issue);
      if (classification.status === "HARD_FAILED") {
        return hard(input, classificationCode(classification), classification.message);
      }
      if (classification.status === "WARNING") warnings.push(issue.issueId);
      if (
        classification.status === "PASSED" &&
        !input.retestPassRevisionIds.includes(result.resultRevisionId)
      ) {
        return hard(
          input,
          "ACCEPTANCE_RETEST_REQUIRED",
          "已关闭问题仍需通过锁定重测批次的 PASS 结果。"
        );
      }
    }
  }
  if (warnings.length > 0) {
    return {
      status: "WARNING",
      code: "ACCEPTANCE_ISSUE_WARNING",
      message: "存在可条件放行的轻微验收问题。",
      evidence: evidence(input, warnings)
    };
  }
  return {
    status: "PASSED",
    code: "ACCEPTANCE_ISSUES_PASSED",
    message: "验收失败项与统一问题事实满足 Gate 要求。",
    evidence: evidence(input, [])
  };
}
