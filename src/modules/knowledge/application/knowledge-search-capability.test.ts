import { describe, expect, it, vi } from "vitest";

import { getKnowledgeSearchCapability } from "./knowledge-search-capability";

describe("knowledge search capability", () => {
  it("reports TRIGRAM only when both the extension and the published-version GIN index exist", async () => {
    const client = {
      $queryRaw: vi.fn(async () => [{ extensionAvailable: true, indexAvailable: true }])
    };

    await expect(getKnowledgeSearchCapability(client)).resolves.toEqual("TRIGRAM");
  });

  it("reports explicit DEGRADED mode when the capability query confirms the extension or index is absent", async () => {
    const client = {
      $queryRaw: vi.fn(async () => [{ extensionAvailable: true, indexAvailable: false }])
    };

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
