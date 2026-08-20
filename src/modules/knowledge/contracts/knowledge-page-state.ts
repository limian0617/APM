export type KnowledgePageServerFacts = {
  authorization: "ALLOWED" | "DENIED";
  search: { itemCount: number } | null;
  loading: boolean;
  error: boolean;
  stale: boolean;
  canCreate: boolean;
  canConfirmReuse: boolean;
  canCorrectReuse: boolean;
  reuseContext?: { reuseId: string; version: number } | null;
};

export type KnowledgePageState = {
  status: "NORMAL" | "LOADING" | "EMPTY" | "ERROR" | "DENIED" | "STALE";
  allowedActions: Array<"CREATE" | "CONFIRM_REUSE" | "CORRECT_REUSE">;
  reuseContext: { reuseId: string; version: number } | null;
};

export function buildKnowledgePageState(facts: KnowledgePageServerFacts): KnowledgePageState {
  const reuseContext = facts.reuseContext ?? null;
  if (facts.authorization === "DENIED")
    return { status: "DENIED", allowedActions: [], reuseContext: null };
  if (facts.loading) return { status: "LOADING", allowedActions: [], reuseContext: null };
  if (facts.error) return { status: "ERROR", allowedActions: [], reuseContext: null };
  if (facts.stale) return { status: "STALE", allowedActions: [], reuseContext: null };

  const status = facts.search?.itemCount ? "NORMAL" : "EMPTY";
  const allowedActions: KnowledgePageState["allowedActions"] = [];
  if (facts.canCreate) allowedActions.push("CREATE");
  if (status === "NORMAL" && facts.canConfirmReuse) allowedActions.push("CONFIRM_REUSE");
  if (status === "NORMAL" && facts.canCorrectReuse && reuseContext)
    allowedActions.push("CORRECT_REUSE");
  return {
    status,
    allowedActions,
    reuseContext: allowedActions.includes("CORRECT_REUSE") ? reuseContext : null
  };
}
