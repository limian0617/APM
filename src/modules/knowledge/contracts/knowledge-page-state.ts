export type KnowledgePageServerFacts = {
  authorization: "ALLOWED" | "DENIED";
  search: { itemCount: number } | null;
  loading: boolean;
  error: boolean;
  stale: boolean;
  canCreate: boolean;
  canConfirmReuse: boolean;
  canCorrectReuse: boolean;
};

export type KnowledgePageState = {
  status: "NORMAL" | "LOADING" | "EMPTY" | "ERROR" | "DENIED" | "STALE";
  allowedActions: Array<"CREATE" | "CONFIRM_REUSE" | "CORRECT_REUSE">;
};

export function buildKnowledgePageState(facts: KnowledgePageServerFacts): KnowledgePageState {
  if (facts.authorization === "DENIED") return { status: "DENIED", allowedActions: [] };
  if (facts.loading) return { status: "LOADING", allowedActions: [] };
  if (facts.error) return { status: "ERROR", allowedActions: [] };
  if (facts.stale) return { status: "STALE", allowedActions: [] };

  const status = facts.search?.itemCount ? "NORMAL" : "EMPTY";
  const allowedActions: KnowledgePageState["allowedActions"] = [];
  if (facts.canCreate) allowedActions.push("CREATE");
  if (status === "NORMAL" && facts.canConfirmReuse) allowedActions.push("CONFIRM_REUSE");
  if (status === "NORMAL" && facts.canCorrectReuse) allowedActions.push("CORRECT_REUSE");
  return { status, allowedActions };
}
