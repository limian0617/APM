export type SatOfflineDraftQueueFetchResult = Readonly<{
  status: number;
  body?: unknown;
  fetchedAt: string | null;
  stale?: boolean;
  retryable?: boolean;
}>;

export type SatOfflineDraftQueueState =
  | Readonly<{ projectId: string; status: "loading" }>
  | Readonly<{ projectId: string; status: "denied" }>
  | Readonly<{ projectId: string; status: "empty"; fetchedAt: string | null }>
  | Readonly<{ projectId: string; status: "error"; retryable: boolean }>
  | Readonly<{
      projectId: string;
      status: "ready" | "stale";
      drafts: readonly Record<string, unknown>[];
      allowedActions: readonly string[];
      fetchedAt: string | null;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildSatOfflineDraftQueueState(input: {
  projectId: string;
  result: SatOfflineDraftQueueFetchResult;
}): SatOfflineDraftQueueState {
  if (input.result.status === 401 || input.result.status === 403) {
    return { projectId: input.projectId, status: "denied" };
  }
  if (input.result.status < 200 || input.result.status >= 300) {
    return {
      projectId: input.projectId,
      status: "error",
      retryable: input.result.retryable === true
    };
  }
  if (!isRecord(input.result.body) || !Array.isArray(input.result.body.drafts)) {
    return { projectId: input.projectId, status: "error", retryable: false };
  }
  const drafts = input.result.body.drafts.filter(isRecord);
  if (
    drafts.length !== input.result.body.drafts.length ||
    drafts.some((draft) => draft.projectId !== input.projectId)
  ) {
    return { projectId: input.projectId, status: "error", retryable: false };
  }
  if (drafts.length === 0)
    return { projectId: input.projectId, status: "empty", fetchedAt: input.result.fetchedAt };
  return {
    projectId: input.projectId,
    status: input.result.stale === true ? "stale" : "ready",
    drafts,
    allowedActions: Array.isArray(input.result.body.allowedActions)
      ? input.result.body.allowedActions.filter(
          (action): action is string => typeof action === "string"
        )
      : [],
    fetchedAt: input.result.fetchedAt
  };
}
