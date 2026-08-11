export type DrawingWorkspaceFetchResult =
  | {
      kind: "ok";
      status: number;
      body: unknown;
      fetchedAt: string | null;
      stale: boolean;
    }
  | { kind: "denied"; status: 401 | 403 }
  | { kind: "loading" }
  | { kind: "error"; status: number; retryable: boolean };

export type DrawingWorkspaceAreaState =
  | { status: "ready"; records: readonly Record<string, unknown>[] }
  | { status: "restricted" }
  | { status: "error"; retryable: boolean };

export type DrawingWorkspacePageState =
  | { projectId: string; status: "loading" }
  | { projectId: string; status: "denied" }
  | { projectId: string; status: "error"; retryable: boolean }
  | {
      projectId: string;
      status: "ready" | "empty";
      stale: boolean;
      drawings: readonly Record<string, unknown>[];
      selectionSets: readonly Record<string, unknown>[];
      categories: DrawingWorkspaceAreaState;
      processTags: DrawingWorkspaceAreaState;
      suppliers: DrawingWorkspaceAreaState;
      supplierMatchesRequested: boolean;
      drawingActions: readonly string[];
      selectionActions: readonly string[];
      sourceFetchedAt: Readonly<Record<string, string | null>>;
    };

export const DRAWING_WORKSPACE_FIXTURES = [
  "normal",
  "loading",
  "empty",
  "error",
  "denied",
  "stale",
  "no-match",
  "conflict"
] as const;

export type DrawingWorkspaceFixture = (typeof DRAWING_WORKSPACE_FIXTURES)[number];

export function resolveDrawingWorkspaceFixture(
  value: string | null | undefined,
  environment: string | undefined
): DrawingWorkspaceFixture | null {
  if (environment === "production" || !value) return null;
  return (DRAWING_WORKSPACE_FIXTURES as readonly string[]).includes(value)
    ? (value as DrawingWorkspaceFixture)
    : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordsFromBody(body: unknown, key?: string): readonly Record<string, unknown>[] {
  const candidate = key && record(body) ? body[key] : body;
  return Array.isArray(candidate) ? candidate.filter(record) : [];
}

function actionsFromBody(body: unknown): readonly string[] {
  if (!record(body) || !Array.isArray(body.allowedActions)) return [];
  return body.allowedActions.filter((action): action is string => typeof action === "string");
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function toDrawingWorkspaceFetchResult(input: {
  status: number;
  body?: unknown;
  fetchedAt?: string;
  stale?: boolean;
}): DrawingWorkspaceFetchResult {
  if (input.status === 401 || input.status === 403) {
    return { kind: "denied", status: input.status };
  }
  if (input.status < 200 || input.status >= 300) {
    return {
      kind: "error",
      status: input.status,
      retryable: retryableStatus(input.status)
    };
  }
  return {
    kind: "ok",
    status: input.status,
    body: input.body,
    fetchedAt: input.fetchedAt ?? null,
    stale: input.stale === true
  };
}

function primaryFailure(
  projectId: string,
  sources: readonly DrawingWorkspaceFetchResult[]
): Extract<DrawingWorkspacePageState, { status: "loading" | "denied" | "error" }> | null {
  if (sources.some((source) => source.kind === "loading")) {
    return { projectId, status: "loading" };
  }
  if (sources.some((source) => source.kind === "denied")) {
    return { projectId, status: "denied" };
  }
  const failed = sources.find((source) => source.kind === "error");
  if (failed?.kind === "error") {
    return { projectId, status: "error", retryable: failed.retryable };
  }
  return null;
}

export function buildDrawingWorkspacePageState(input: {
  projectId: string;
  drawings: DrawingWorkspaceFetchResult;
  selections: DrawingWorkspaceFetchResult;
  categories: DrawingWorkspaceFetchResult;
  processTags: DrawingWorkspaceFetchResult;
  suppliers: DrawingWorkspaceFetchResult;
  supplierMatchesRequested?: boolean;
}): DrawingWorkspacePageState {
  const primary = primaryFailure(input.projectId, [
    input.drawings,
    input.selections
    // Global configuration access controls editing options, not project drawing read access.
  ]);
  if (primary) return primary;

  const okSources = [input.drawings, input.selections, input.categories, input.processTags].filter(
    (source): source is Extract<DrawingWorkspaceFetchResult, { kind: "ok" }> => source.kind === "ok"
  );
  const drawings = recordsFromBody(
    input.drawings.kind === "ok" ? input.drawings.body : null,
    "drawings"
  );
  const selectionSets = recordsFromBody(
    input.selections.kind === "ok" ? input.selections.body : null,
    "selectionSets"
  );
  const toOptionalAreaState = (
    source: DrawingWorkspaceFetchResult,
    key: string
  ): DrawingWorkspaceAreaState =>
    source.kind === "denied"
      ? { status: "restricted" }
      : source.kind === "error"
        ? { status: "error", retryable: source.retryable }
        : source.kind === "loading"
          ? { status: "error", retryable: true }
          : { status: "ready", records: recordsFromBody(source.body, key) };
  const categories = toOptionalAreaState(input.categories, "categories");
  const processTags = toOptionalAreaState(input.processTags, "processTags");
  const supplierState: DrawingWorkspaceAreaState =
    input.suppliers.kind === "denied"
      ? { status: "restricted" }
      : input.suppliers.kind === "error"
        ? { status: "error", retryable: input.suppliers.retryable }
        : input.suppliers.kind === "loading"
          ? { status: "error", retryable: true }
          : {
              status: "ready",
              records: recordsFromBody(input.suppliers.body, "matches")
            };
  const stale = okSources.some((source) => source.stale);
  const sourceFetchedAt = {
    drawings: input.drawings.kind === "ok" ? input.drawings.fetchedAt : null,
    selections: input.selections.kind === "ok" ? input.selections.fetchedAt : null,
    categories: input.categories.kind === "ok" ? input.categories.fetchedAt : null,
    processTags: input.processTags.kind === "ok" ? input.processTags.fetchedAt : null,
    suppliers: input.suppliers.kind === "ok" ? input.suppliers.fetchedAt : null
  };
  const empty = drawings.length === 0 && selectionSets.length === 0;
  return {
    projectId: input.projectId,
    status: empty ? "empty" : "ready",
    stale,
    drawings,
    selectionSets,
    categories,
    processTags,
    suppliers: supplierState,
    supplierMatchesRequested: input.supplierMatchesRequested !== false,
    drawingActions: actionsFromBody(input.drawings.kind === "ok" ? input.drawings.body : null),
    selectionActions: actionsFromBody(
      input.selections.kind === "ok" ? input.selections.body : null
    ),
    sourceFetchedAt
  };
}
