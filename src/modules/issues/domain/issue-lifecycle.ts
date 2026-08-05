export const ISSUE_CATEGORIES = [
  "SAFETY",
  "FUNCTION",
  "PERFORMANCE",
  "APPEARANCE",
  "DELIVERY_COMPLETENESS"
] as const;

export const ISSUE_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];
export type IssueStatus =
  "PENDING_ACCEPTANCE" | "ANALYZING" | "PROCESSING" | "PENDING_VERIFICATION" | "CLOSED";
export type IssueAction =
  "START_ANALYSIS" | "START_PROCESSING" | "SUBMIT_VERIFICATION" | "VERIFY_CLOSE" | "REOPEN";

export type IssueIndicatorInput = {
  status: IssueStatus;
  dueDate: string | null;
  hasOpenBlocker: boolean;
};

export class IssueLifecycleError extends Error {}

const transitions: Readonly<Record<IssueStatus, Partial<Record<IssueAction, IssueStatus>>>> = {
  PENDING_ACCEPTANCE: { START_ANALYSIS: "ANALYZING" },
  ANALYZING: { START_PROCESSING: "PROCESSING" },
  PROCESSING: { SUBMIT_VERIFICATION: "PENDING_VERIFICATION" },
  PENDING_VERIFICATION: { VERIFY_CLOSE: "CLOSED" },
  CLOSED: { REOPEN: "ANALYZING" }
};

export function nextIssueStatus(status: IssueStatus, action: IssueAction): IssueStatus {
  const next = transitions[status]?.[action];
  if (!next) throw new IssueLifecycleError(`问题状态 ${status} 不能执行 ${action}。`);
  return next;
}

export function requiresIndependentVerification(severity: IssueSeverity): boolean {
  return severity === "HIGH" || severity === "CRITICAL";
}

export function deriveIssueIndicators(input: IssueIndicatorInput, now: Date) {
  const currentDay = now.toISOString().slice(0, 10);
  const isOpen = input.status !== "CLOSED";
  return {
    isOverdue: isOpen && input.dueDate !== null && input.dueDate < currentDay,
    isBlocked: isOpen && input.hasOpenBlocker
  };
}

export function normalizeIssueTags(tags: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string" || !tag.trim() || tag.trim().length > 100) {
      throw new IssueLifecycleError("问题标签必须是 1 到 100 个字符。");
    }
    const value = tag.trim();
    if (!seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  }
  return normalized;
}
