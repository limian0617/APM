import { describe, expect, it } from "vitest";

import {
  deriveIssueIndicators,
  ISSUE_CATEGORIES,
  ISSUE_SEVERITIES,
  IssueLifecycleError,
  nextIssueStatus,
  normalizeIssueTags,
  requiresIndependentVerification
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

describe("APM-071 issue indicators and independent verification", () => {
  it("requires an independent verifier for high-severity issues", () => {
    expect(requiresIndependentVerification("LOW")).toBe(false);
    expect(requiresIndependentVerification("MEDIUM")).toBe(false);
    expect(requiresIndependentVerification("HIGH")).toBe(true);
    expect(requiresIndependentVerification("CRITICAL")).toBe(true);
  });

  it("derives overdue and blocked flags without changing the lifecycle status", () => {
    expect(
      deriveIssueIndicators(
        {
          status: "PROCESSING",
          dueDate: "2026-08-04",
          hasOpenBlocker: true
        },
        new Date("2026-08-05T08:00:00.000Z")
      )
    ).toEqual({ isOverdue: true, isBlocked: true });
    expect(
      deriveIssueIndicators(
        {
          status: "CLOSED",
          dueDate: "2026-08-04",
          hasOpenBlocker: true
        },
        new Date("2026-08-05T08:00:00.000Z")
      )
    ).toEqual({ isOverdue: false, isBlocked: false });
  });
});
