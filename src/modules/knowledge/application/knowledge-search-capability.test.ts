import { describe, expect, it, vi } from "vitest";

import { getKnowledgeSearchCapability } from "./knowledge-search-capability";

function capability(overrides: Record<string, boolean> = {}) {
  return {
    extensionAvailable: true,
    indexOnTargetTable: true,
    indexUsesGin: true,
    indexUsesTrigram: true,
    indexValid: true,
    indexReady: true,
    indexDefinitionCorrect: true,
    ...overrides
  };
}

describe("knowledge search capability", () => {
  it("reports TRIGRAM only when the extension and a usable target GIN trigram index are confirmed", async () => {
    const client = {
      $queryRaw: vi.fn(async () => [capability()])
    };

    await expect(getKnowledgeSearchCapability(client)).resolves.toEqual("TRIGRAM");
  });

  it.each([
    ["extension is absent", { extensionAvailable: false }],
    ["same-name index targets another table", { indexOnTargetTable: false }],
    ["same-name target index uses a non-GIN access method", { indexUsesGin: false }],
    ["same-name GIN index has no trigram opclass", { indexUsesTrigram: false }],
    ["same-name GIN trigram index is invalid", { indexValid: false }],
    ["same-name GIN trigram index is not ready", { indexReady: false }],
    [
      "same-name target GIN trigram index has the wrong key definition",
      {
        indexDefinitionCorrect: false
      }
    ]
  ])("reports DEGRADED when %s", async (_label, facts) => {
    const client = { $queryRaw: vi.fn(async () => [capability(facts)]) };

    await expect(getKnowledgeSearchCapability(client)).resolves.toEqual("DEGRADED");
  });

  it("fails closed instead of falsely advertising degraded search when the server probe fails", async () => {
    const client = {
      $queryRaw: vi.fn(async () => Promise.reject(new Error("database unavailable")))
    };

    await expect(getKnowledgeSearchCapability(client)).rejects.toMatchObject({
      code: "KNOWLEDGE_SEARCH_CAPABILITY_UNAVAILABLE",
      status: 503
    });
  });
});
