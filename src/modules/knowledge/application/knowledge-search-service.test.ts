import { describe, expect, it, vi } from "vitest";

import type { KnowledgeSearchCapability } from "./knowledge-search-capability";
import { searchPublishedKnowledge } from "./knowledge-search-service";

const row = {
  id: "knowledge-version-1",
  entry: { code: "KNOW-001" },
  versionNo: 2,
  title: "Servo jitter tuning",
  sanitizedSummary: "Tune without customer identifiers.",
  experienceType: "COMMISSIONING",
  discipline: "ELECTRICAL",
  normalizedKeywordsJson: ["servo", "jitter"],
  applicableProjectTypesJson: ["CUSTOMER_DELIVERY"],
  applicableStageCodesJson: ["S5"],
  status: "PUBLISHED",
  publishedAt: new Date("2026-08-14T08:00:00.000Z")
};

describe("knowledge search service", () => {
  it("uses the confirmed trigram repository path and returns only the public sanitized DTO", async () => {
    const repository = {
      searchPublishedTrigram: vi.fn(async () => [row]),
      searchPublishedBoundedIlike: vi.fn(async () => [])
    };

    const result = await searchPublishedKnowledge(
      { query: "servo", page: 1, pageSize: 20 },
      {
        getCapability: vi.fn(async (): Promise<KnowledgeSearchCapability> => "TRIGRAM"),
        repository
      }
    );

    expect(repository.searchPublishedTrigram).toHaveBeenCalledWith(
      expect.objectContaining({ query: "servo", take: 21 })
    );
    expect(result).toMatchObject({ capability: "TRIGRAM", warningCode: null, nextCursor: null });
    expect(result.items).toEqual([
      expect.objectContaining({ entryCode: "KNOW-001", sanitizedSummary: row.sanitizedSummary })
    ]);
    expect(result.items[0]).not.toHaveProperty("sourceProjectId");
    expect(result.items[0]).not.toHaveProperty("id");
  });

  it("uses bounded stable ILIKE when capability is confirmed degraded", async () => {
    const repository = {
      searchPublishedTrigram: vi.fn(async () => []),
      searchPublishedBoundedIlike: vi.fn(async () => [row])
    };

    const result = await searchPublishedKnowledge(
      { query: "伺服", page: 5, pageSize: 20 },
      {
        getCapability: vi.fn(async (): Promise<KnowledgeSearchCapability> => "DEGRADED"),
        repository
      }
    );

    expect(repository.searchPublishedBoundedIlike).toHaveBeenCalledWith(
      expect.objectContaining({ query: "伺服", skip: 80, take: 20, maxWindow: 100 })
    );
    expect(result).toMatchObject({ capability: "DEGRADED", warningCode: "SEARCH_DEGRADED" });
  });

  it("rejects queries beyond the Unicode and bounded-window limits before reading the repository", async () => {
    const repository = {
      searchPublishedTrigram: vi.fn(),
      searchPublishedBoundedIlike: vi.fn()
    };

    await expect(
      searchPublishedKnowledge(
        { query: "伺".repeat(65), page: 1, pageSize: 20 },
        {
          getCapability: vi.fn(async (): Promise<KnowledgeSearchCapability> => "DEGRADED"),
          repository
        }
      )
    ).rejects.toMatchObject({ code: "KNOWLEDGE_SEARCH_QUERY_INVALID", status: 422 });
    await expect(
      searchPublishedKnowledge(
        { query: "servo", page: 6, pageSize: 20 },
        {
          getCapability: vi.fn(async (): Promise<KnowledgeSearchCapability> => "DEGRADED"),
          repository
        }
      )
    ).rejects.toMatchObject({ code: "KNOWLEDGE_SEARCH_WINDOW_EXCEEDED", status: 422 });
    expect(repository.searchPublishedTrigram).not.toHaveBeenCalled();
    expect(repository.searchPublishedBoundedIlike).not.toHaveBeenCalled();
  });
});
