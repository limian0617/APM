import { describe, expect, it } from "vitest";

import {
  AcceptanceIssuePolicyError,
  classifyAcceptanceIssue,
  assertFailureRevisionLink,
  assertResidualCanClose,
  type AcceptanceIssueFact
} from "./acceptance-issue-policy";

const baseFailure = {
  projectId: "project-1",
  batchId: "batch-1",
  resultId: "result-1",
  revisionId: "revision-1",
  acceptanceType: "FAT" as const,
  decision: "FAIL" as const
};

describe("APM-101 acceptance issue policy", () => {
  it("allows only a FAIL revision from the same project and batch", () => {
    expect(() =>
      assertFailureRevisionLink({
        projectId: "project-1",
        failure: baseFailure,
        expectedBatchId: "batch-1"
      })
    ).not.toThrow();
    expect(() =>
      assertFailureRevisionLink({
        projectId: "project-1",
        failure: { ...baseFailure, decision: "PASS" },
        expectedBatchId: "batch-1"
      })
    ).toThrowError(AcceptanceIssuePolicyError);
    expect(() =>
      assertFailureRevisionLink({
        projectId: "project-1",
        failure: { ...baseFailure, projectId: "project-2" },
        expectedBatchId: "batch-1"
      })
    ).toThrowError("失败结果不属于当前项目。");
    expect(() =>
      assertFailureRevisionLink({
        projectId: "project-1",
        failure: baseFailure,
        expectedBatchId: "batch-2"
      })
    ).toThrowError("失败结果不属于当前验收批次。");
  });

  const issue = (overrides: Partial<AcceptanceIssueFact> = {}): AcceptanceIssueFact => ({
    issueId: "issue-1",
    category: "PERFORMANCE",
    severity: "LOW",
    status: "PROCESSING",
    ownerMembershipId: "owner-1",
    verifierMembershipId: "verifier-1",
    dueDate: "2026-08-20",
    verificationPlan: "重测后验证",
    ...overrides
  });

  it("classifies safety/function/high/critical and missing facts as HARD_FAILED", () => {
    expect(classifyAcceptanceIssue(issue({ category: "SAFETY" })).status).toBe("HARD_FAILED");
    expect(classifyAcceptanceIssue(issue({ category: "FUNCTION" })).status).toBe("HARD_FAILED");
    expect(classifyAcceptanceIssue(issue({ severity: "HIGH" })).status).toBe("HARD_FAILED");
    expect(classifyAcceptanceIssue(issue({ severity: "CRITICAL" })).status).toBe("HARD_FAILED");
    expect(classifyAcceptanceIssue(issue({ ownerMembershipId: null })).status).toBe("HARD_FAILED");
    expect(classifyAcceptanceIssue(issue({ dueDate: null })).status).toBe("HARD_FAILED");
  });

  it("classifies low/medium performance, appearance and delivery issues as WARNING", () => {
    for (const category of ["PERFORMANCE", "APPEARANCE", "DELIVERY_COMPLETENESS"] as const) {
      expect(classifyAcceptanceIssue(issue({ category, severity: "MEDIUM" })).status).toBe(
        "WARNING"
      );
    }
    expect(
      classifyAcceptanceIssue(issue({ category: "PERFORMANCE", severity: "HIGH" })).status
    ).toBe("HARD_FAILED");
  });

  it("requires issue closure and a locked PASS retest before residual completion", () => {
    expect(() =>
      assertResidualCanClose({ issueStatus: "PROCESSING", retestPass: true })
    ).toThrowError("关联问题必须先关闭。");
    expect(() => assertResidualCanClose({ issueStatus: "CLOSED", retestPass: false })).toThrowError(
      "必须存在锁定重测批次的 PASS 结果。"
    );
    expect(() => assertResidualCanClose({ issueStatus: "CLOSED", retestPass: true })).not.toThrow();
  });
});
