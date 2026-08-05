import { describe, expect, it } from "vitest";

import {
  ISSUE_CATEGORIES,
  ISSUE_SEVERITIES,
  IssueLifecycleError,
  nextIssueStatus,
  normalizeIssueTags
} from "./issue-lifecycle";

describe("APM-070 issue lifecycle", () => {
  it("keeps the five fixed primary categories and separates severity", () => {
    expect(ISSUE_CATEGORIES).toEqual([
      "SAFETY",
      "FUNCTION",
      "PERFORMANCE",
      "APPEARANCE",
      "DELIVERY_COMPLETENESS"
    ]);
    expect(ISSUE_SEVERITIES).toEqual(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
  });

  it("only advances a problem through analysis, processing, verification, and closure", () => {
    expect(nextIssueStatus("PENDING_ACCEPTANCE", "START_ANALYSIS")).toBe("ANALYZING");
    expect(nextIssueStatus("ANALYZING", "START_PROCESSING")).toBe("PROCESSING");
    expect(nextIssueStatus("PROCESSING", "SUBMIT_VERIFICATION")).toBe("PENDING_VERIFICATION");
    expect(nextIssueStatus("PENDING_VERIFICATION", "VERIFY_CLOSE")).toBe("CLOSED");
  });

  it("rejects skipped workflow states and allows a closed issue to be reopened into analysis", () => {
    expect(() => nextIssueStatus("PENDING_ACCEPTANCE", "VERIFY_CLOSE")).toThrow(
      IssueLifecycleError
    );
    expect(nextIssueStatus("CLOSED", "REOPEN")).toBe("ANALYZING");
  });

  it("normalizes distinct phenomenon tags without accepting empty values", () => {
    expect(normalizeIssueTags(["  缺料  ", "干涉", "缺料"])).toEqual(["缺料", "干涉"]);
    expect(() => normalizeIssueTags(["  "])).toThrow(IssueLifecycleError);
  });
});
