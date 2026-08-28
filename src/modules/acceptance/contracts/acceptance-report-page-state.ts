export const ACCEPTANCE_REPORT_PAGE_FIXTURES = [
  "normal",
  "loading",
  "empty",
  "error",
  "denied",
  "stale",
  "generating",
  "failed",
  "conflict"
] as const;

export type AcceptanceReportPageFixture = (typeof ACCEPTANCE_REPORT_PAGE_FIXTURES)[number];

export type AcceptanceReportFetchResult = Readonly<{
  status: number;
  body?: unknown;
  fetchedAt: string | null;
  stale: boolean;
  retryable: boolean;
}>;

export type AcceptanceReportPageState =
  | Readonly<{ projectId: string; status: "loading" | "denied" | "error"; retryable?: boolean }>
  | Readonly<{
      projectId: string;
      status: "empty" | "ready" | "stale";
      reports: readonly Record<string, unknown>[];
      allowedActions: readonly string[];
      fetchedAt: string | null;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveAcceptanceReportFixture(
  fixture: string | null | undefined,
  environment: string | undefined
): AcceptanceReportPageFixture | null {
  if (environment === "production") return null;
  return ACCEPTANCE_REPORT_PAGE_FIXTURES.includes(fixture as AcceptanceReportPageFixture)
    ? (fixture as AcceptanceReportPageFixture)
    : null;
}

export function buildAcceptanceReportPageState(input: {
  projectId: string;
  result: AcceptanceReportFetchResult;
}): AcceptanceReportPageState {
  if (input.result.status === 401 || input.result.status === 403) {
    return { projectId: input.projectId, status: "denied" };
  }
  if (input.result.status < 200 || input.result.status >= 300 || !isRecord(input.result.body)) {
    return { projectId: input.projectId, status: "error", retryable: input.result.retryable };
  }
  const reports = Array.isArray(input.result.body.reports)
    ? input.result.body.reports.filter(
        (report): report is Record<string, unknown> =>
          isRecord(report) &&
          (typeof report.projectId !== "string" || report.projectId === input.projectId)
      )
    : null;
  if (!reports) return { projectId: input.projectId, status: "error", retryable: false };
  const allowedActions = Array.isArray(input.result.body.allowedActions)
    ? input.result.body.allowedActions.filter(
        (action): action is string => typeof action === "string"
      )
    : [];
  return {
    projectId: input.projectId,
    status: reports.length === 0 ? "empty" : input.result.stale ? "stale" : "ready",
    reports,
    allowedActions,
    fetchedAt: input.result.fetchedAt
  };
}
