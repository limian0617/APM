import { describe, expect, it } from "vitest";

import { buildKnowledgePageState, type KnowledgePageServerFacts } from "./knowledge-page-state";

const base: KnowledgePageServerFacts = {
  authorization: "ALLOWED",
  search: { itemCount: 1 },
  loading: false,
  error: false,
  stale: false,
  canCreate: true,
  canConfirmReuse: true,
  canCorrectReuse: true,
  reuseContext: { reuseId: "reuse-1", version: 2 }
};

describe("knowledge page state", () => {
  it("derives NORMAL and allowed actions only from server facts", () => {
    const state = buildKnowledgePageState(base);

    expect(state).toEqual({
      status: "NORMAL",
      allowedActions: ["CREATE", "CONFIRM_REUSE", "CORRECT_REUSE"],
      reuseContext: { reuseId: "reuse-1", version: 2 }
    });
    expect(state).not.toHaveProperty("sourceProjectId");
    expect(state).not.toHaveProperty("authorization");
  });

  it("derives LOADING, EMPTY, and ERROR without exposing actions", () => {
    expect(buildKnowledgePageState({ ...base, loading: true })).toEqual({
      status: "LOADING",
      allowedActions: [],
      reuseContext: null
    });
    expect(buildKnowledgePageState({ ...base, search: { itemCount: 0 } })).toEqual({
      status: "EMPTY",
      allowedActions: ["CREATE"],
      reuseContext: null
    });
    expect(buildKnowledgePageState({ ...base, error: true })).toEqual({
      status: "ERROR",
      allowedActions: [],
      reuseContext: null
    });
  });

  it("suppresses all actions for DENIED and STALE server states", () => {
    expect(buildKnowledgePageState({ ...base, authorization: "DENIED" })).toEqual({
      status: "DENIED",
      allowedActions: [],
      reuseContext: null
    });
    expect(buildKnowledgePageState({ ...base, stale: true })).toEqual({
      status: "STALE",
      allowedActions: [],
      reuseContext: null
    });
  });
});
