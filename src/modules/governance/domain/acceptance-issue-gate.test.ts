import { describe, expect, it } from "vitest";

import { evaluateAcceptanceIssueGate } from "./acceptance-issue-gate";

const issue = (overrides: Record<string, unknown> = {}) => ({
  issueId: "issue-1",
  category: "PERFORMANCE" as const,
  severity: "LOW" as const,
  status: "PROCESSING" as const,
  ownerMembershipId: "owner-1",
  verifierMembershipId: "verifier-1",
  dueDate: "2026-08-20",
  verificationPlan: "锁定重测后验证",
  ...overrides
});

const base = {
  factsAvailable: true,
  acceptanceType: "FAT" as const,
  lockedBatchId: "batch-locked",
  lockedBatchChain: ["batch-locked", "batch-original"],
  templateVersionId: "template-version-1",
  templateChecksum: "sha256:template",
  sourceChecksum: "sha256:acceptance-facts",
  requiredResultMissing: false,
  results: [
    {
      resultRevisionId: "revision-1",
      itemCode: "POWER",
      decision: "FAIL" as const,
      issueIds: ["issue-1"]
    }
  ],
  issues: [issue()],
  retestPassRevisionIds: [] as string[]
};

describe("APM-101 acceptance issue Gate checker", () => {
  it("hard-fails unavailable facts, missing required results and unlinked FAIL", () => {
    expect(evaluateAcceptanceIssueGate({ ...base, factsAvailable: false }).status).toBe(
      "HARD_FAILED"
    );
    expect(evaluateAcceptanceIssueGate({ ...base, requiredResultMissing: true }).status).toBe(
      "HARD_FAILED"
    );
    expect(
      evaluateAcceptanceIssueGate({
        ...base,
        results: [{ ...base.results[0], issueIds: [] }]
      }).code
    ).toBe("ACCEPTANCE_FAIL_ISSUE_UNLINKED");
  });

  it("hard-fails safety/function/high/critical issues and warns only for governed minor issues", () => {
    for (const overrides of [
      { category: "SAFETY" },
      { category: "FUNCTION" },
      { severity: "HIGH" },
      { severity: "CRITICAL" }
    ]) {
      expect(evaluateAcceptanceIssueGate({ ...base, issues: [issue(overrides)] }).status).toBe(
        "HARD_FAILED"
      );
    }
    expect(evaluateAcceptanceIssueGate(base)).toMatchObject({
      status: "WARNING",
      code: "ACCEPTANCE_ISSUE_WARNING"
    });
  });

  it("requires a locked PASS retest after a linked issue is closed", () => {
    const closed = {
      ...base,
      issues: [issue({ status: "CLOSED" })]
    };
    expect(evaluateAcceptanceIssueGate(closed).code).toBe("ACCEPTANCE_RETEST_REQUIRED");
    expect(
      evaluateAcceptanceIssueGate({ ...closed, retestPassRevisionIds: ["revision-1"] }).status
    ).toBe("PASSED");
  });

  it("returns a deterministic snapshot-ready evidence object", () => {
    const result = evaluateAcceptanceIssueGate(base);
    expect(result.evidence).toMatchObject({
      sourceChecksum: "sha256:acceptance-facts",
      acceptanceType: "FAT",
      lockedBatchId: "batch-locked",
      lockedBatchChain: ["batch-locked", "batch-original"],
      templateVersionId: "template-version-1",
      templateChecksum: "sha256:template",
      resultRevisionIds: ["revision-1"],
      issueIds: ["issue-1"],
      failureLinks: [{ resultRevisionId: "revision-1", issueIds: ["issue-1"] }],
      issueFacts: [{ issueId: "issue-1", category: "PERFORMANCE" }]
    });
  });
});
