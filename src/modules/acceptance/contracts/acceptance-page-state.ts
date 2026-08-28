export const ACCEPTANCE_PAGE_FIXTURES = [
  "normal",
  "loading",
  "empty",
  "error",
  "denied",
  "stale",
  "generating",
  "failed",
  "conflict",
  "offline"
] as const;

export type AcceptancePageFixture = (typeof ACCEPTANCE_PAGE_FIXTURES)[number];

export type AcceptanceFetchResult = Readonly<{
  kind: "response" | "network-error";
  status: number;
  body?: unknown;
  fetchedAt: string | null;
  stale: boolean;
  retryable: boolean;
}>;

export type AcceptancePageDataState = Readonly<{
  projectId: string;
  status: "ready" | "stale";
  templates: readonly Record<string, unknown>[];
  batches: readonly Record<string, unknown>[];
  batchAllowedActions?: readonly string[];
  batchDetail: Record<string, unknown> | null;
  timestamps: Readonly<{
    templates: string | null;
    batches: string | null;
    batchDetail: string | null;
  }>;
}>;

export type AcceptanceNonDataState =
  | Readonly<{ projectId: string; status: "loading" }>
  | Readonly<{
      projectId: string;
      status: "empty";
      timestamps: AcceptancePageDataState["timestamps"];
    }>
  | Readonly<{ projectId: string; status: "denied" }>
  | Readonly<{ projectId: string; status: "error"; retryable: boolean }>;

export type AcceptancePageState = AcceptanceNonDataState | AcceptancePageDataState;

export function isAcceptancePageDataState(
  state: AcceptancePageState
): state is AcceptancePageDataState {
  return state.status === "ready" || state.status === "stale";
}

type AcceptanceFetchInput = Readonly<{
  status: number;
  body?: unknown;
  fetchedAt?: string;
  stale?: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function items(body: unknown, field: string): readonly Record<string, unknown>[] | null {
  if (!isRecord(body) || !Array.isArray(body[field])) return null;
  return body[field].filter(isRecord);
}

function isSuccess(result: AcceptanceFetchResult) {
  return result.kind === "response" && result.status >= 200 && result.status < 300;
}

function isDenied(result: AcceptanceFetchResult) {
  return result.status === 401 || result.status === 403;
}

function retryable(result: AcceptanceFetchResult) {
  return result.retryable;
}

function hasCurrentProject(value: Record<string, unknown>, projectId: string) {
  return typeof value.projectId !== "string" || value.projectId === projectId;
}

export function resolveAcceptanceFixture(
  fixture: string | null | undefined,
  environment: string | undefined
): AcceptancePageFixture | null {
  if (environment === "production") return null;
  return ACCEPTANCE_PAGE_FIXTURES.includes(fixture as AcceptancePageFixture)
    ? (fixture as AcceptancePageFixture)
    : null;
}

export function toAcceptanceFetchResult(input: AcceptanceFetchInput): AcceptanceFetchResult {
  const isNetworkError = input.status === 0;
  return {
    kind: isNetworkError ? "network-error" : "response",
    status: input.status,
    body: input.body,
    fetchedAt: input.fetchedAt ?? null,
    stale: input.stale === true,
    retryable:
      isNetworkError || input.status === 502 || input.status === 503 || input.status === 504
  };
}

export function buildAcceptancePageState(input: {
  projectId: string;
  templates: AcceptanceFetchResult;
  batches: AcceptanceFetchResult;
  batchDetail?: AcceptanceFetchResult;
}): AcceptancePageState {
  const timestamps = {
    templates: input.templates.fetchedAt,
    batches: input.batches.fetchedAt,
    batchDetail: input.batchDetail?.fetchedAt ?? null
  };
  if (isDenied(input.templates) || isDenied(input.batches))
    return { projectId: input.projectId, status: "denied" };
  if (!isSuccess(input.templates) || !isSuccess(input.batches)) {
    return {
      projectId: input.projectId,
      status: "error",
      retryable: retryable(input.templates) || retryable(input.batches)
    };
  }
  const templates = items(input.templates.body, "templates");
  const batches = items(input.batches.body, "batches");
  if (
    !templates ||
    !batches ||
    !batches.every((batch) => hasCurrentProject(batch, input.projectId))
  ) {
    return { projectId: input.projectId, status: "error", retryable: false };
  }
  if (input.batchDetail) {
    if (
      isDenied(input.batchDetail) ||
      !isSuccess(input.batchDetail) ||
      !isRecord(input.batchDetail.body)
    ) {
      return {
        projectId: input.projectId,
        status: "error",
        retryable: retryable(input.batchDetail)
      };
    }
    const batch = input.batchDetail.body.batch;
    if (!isRecord(batch) || !hasCurrentProject(batch, input.projectId)) {
      return { projectId: input.projectId, status: "error", retryable: false };
    }
  }
  if (templates.length === 0 && batches.length === 0) {
    return { projectId: input.projectId, status: "empty", timestamps };
  }
  const detail =
    input.batchDetail && isRecord(input.batchDetail.body) ? input.batchDetail.body : null;
  return {
    projectId: input.projectId,
    status:
      input.templates.stale || input.batches.stale || input.batchDetail?.stale ? "stale" : "ready",
    templates,
    batches,
    batchAllowedActions:
      isRecord(input.batches.body) && Array.isArray(input.batches.body.allowedActions)
        ? input.batches.body.allowedActions.filter(
            (value): value is string => typeof value === "string"
          )
        : [],
    batchDetail: detail,
    timestamps
  };
}
