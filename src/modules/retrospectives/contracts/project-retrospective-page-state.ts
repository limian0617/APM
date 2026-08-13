export type RetrospectivePageStateInput = {
  projectId: string;
  archiveA: { id: string; status: string } | null;
  currentVersion: { id: string; status: string } | null;
  latestApprovedVersion: { id: string; status: string } | null;
  archiveB: { id: string; status: string } | null;
  closurePolicy: { id: string; status: string } | null;
  canCreate: boolean;
  canSubmit: boolean;
  canReview: boolean;
  canGenerateArchiveB: boolean;
  canRunG9: boolean;
  canClose: boolean;
};

export type ProjectRetrospectivePageState = RetrospectivePageStateInput & {
  status: "NORMAL" | "EMPTY" | "DENIED" | "STALE";
  allowedActions: Array<
    "CREATE" | "SUBMIT" | "REVIEW" | "GENERATE_ARCHIVE_B" | "RUN_G9" | "CLOSE_PROJECT"
  >;
};

export function buildProjectRetrospectivePageState(
  input: RetrospectivePageStateInput
): ProjectRetrospectivePageState {
  const stale =
    input.currentVersion !== null &&
    input.latestApprovedVersion !== null &&
    input.currentVersion.id !== input.latestApprovedVersion.id;
  const allowedActions: ProjectRetrospectivePageState["allowedActions"] = [];
  if (input.canCreate && !input.currentVersion) allowedActions.push("CREATE");
  if (input.canSubmit && input.currentVersion?.status === "DRAFT") allowedActions.push("SUBMIT");
  if (input.canReview && input.currentVersion?.status === "IN_REVIEW")
    allowedActions.push("REVIEW");
  const hasFrozenArchiveA = input.archiveA?.status === "READY";
  const hasFrozenArchiveB = input.archiveB?.status === "READY";
  const hasExactClosurePolicy = input.closurePolicy?.status === "ACTIVE";
  if (
    !stale &&
    input.canGenerateArchiveB &&
    hasFrozenArchiveA &&
    input.latestApprovedVersion?.status === "APPROVED"
  ) {
    allowedActions.push("GENERATE_ARCHIVE_B");
  }
  if (!stale && input.canRunG9 && hasFrozenArchiveB && hasExactClosurePolicy) {
    allowedActions.push("RUN_G9");
  }
  if (!stale && input.canClose && hasFrozenArchiveB && hasExactClosurePolicy) {
    allowedActions.push("CLOSE_PROJECT");
  }
  return {
    ...input,
    status: stale ? "STALE" : input.currentVersion ? "NORMAL" : "EMPTY",
    allowedActions
  };
}
