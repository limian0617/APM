export type ArchivePageState =
  | { projectId: string; status: "loading" }
  | { projectId: string; status: "denied" }
  | { projectId: string; status: "error"; retryable: boolean }
  | { projectId: string; status: "empty"; allowedActions: string[] }
  | {
      projectId: string;
      status: "ready" | "stale";
      archive: Record<string, any>;
      project?: Record<string, any>;
      allowedActions: string[];
      fetchedAt: string | null;
    };

export function buildArchivePageState(input: {
  projectId: string;
  result: { status: number; body?: unknown; fetchedAt?: string | null; stale?: boolean };
  allowedActions?: string[];
}): ArchivePageState {
  if (input.result.status === 401 || input.result.status === 403)
    return { projectId: input.projectId, status: "denied" };
  if (input.result.status < 200 || input.result.status >= 300) {
    return {
      projectId: input.projectId,
      status: "error",
      retryable: [0, 502, 503, 504].includes(input.result.status)
    };
  }
  const record =
    input.result.body && typeof input.result.body === "object"
      ? (input.result.body as Record<string, any>)
      : null;
  const allowedActions = Array.isArray(record?.allowedActions)
    ? record.allowedActions.filter((value): value is string => typeof value === "string")
    : (input.allowedActions ?? []);
  if (!record || !record.archive)
    return { projectId: input.projectId, status: "empty", allowedActions };
  return {
    projectId: input.projectId,
    status: input.result.stale ? "stale" : "ready",
    archive: record.archive,
    project: record.project,
    allowedActions,
    fetchedAt: input.result.fetchedAt ?? null
  };
}
