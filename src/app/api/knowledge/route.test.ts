import { beforeEach, describe, expect, it, vi } from "vitest";

const systemGuard = vi.hoisted(() => ({ authorizeSystemRequest: vi.fn() }));
const searchService = vi.hoisted(() => ({ searchPublishedKnowledge: vi.fn() }));

vi.mock("@/lib/auth/system-guard", () => systemGuard);
vi.mock("@/modules/knowledge/application/knowledge-search-service", () => searchService);

import { GET } from "./route";

describe("GET /api/knowledge", () => {
  beforeEach(() => {
    systemGuard.authorizeSystemRequest.mockReset();
    searchService.searchPublishedKnowledge.mockReset();
  });

  it("authorizes knowledge search and returns a source-sanitized public DTO", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reader-1" }
    });
    searchService.searchPublishedKnowledge.mockResolvedValue({
      capability: "DEGRADED",
      warningCode: "SEARCH_DEGRADED",
      nextCursor: null,
      items: [
        {
          entryCode: "KNW-001",
          version: 1,
          title: "安全复位",
          sanitizedSummary: "已移除来源敏感信息。",
          experienceType: "LESSON_LEARNED",
          discipline: "MECHANICAL",
          keywords: ["复位"],
          applicableProjectTypes: ["LINE"],
          applicableStageCodes: ["S4"],
          status: "PUBLISHED",
          sourceProjectId: "must-not-leak",
          issueId: "must-not-leak"
        }
      ]
    });

    const response = await GET(
      new Request("http://localhost/api/knowledge?query=%E5%A4%8D%E4%BD%8D")
    );

    expect(systemGuard.authorizeSystemRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "KNOWLEDGE_READ",
      "KNOWLEDGE_ENTRY",
      null
    );
    expect(searchService.searchPublishedKnowledge).toHaveBeenCalledWith(
      { query: "复位", page: 1, pageSize: 20 },
      expect.objectContaining({
        getCapability: expect.any(Function),
        repository: expect.any(Object)
      })
    );
    await expect(response.json()).resolves.toEqual({
      capability: "DEGRADED",
      warningCode: "SEARCH_DEGRADED",
      nextCursor: null,
      items: [
        {
          entryCode: "KNW-001",
          version: 1,
          title: "安全复位",
          sanitizedSummary: "已移除来源敏感信息。",
          experienceType: "LESSON_LEARNED",
          discipline: "MECHANICAL",
          keywords: ["复位"],
          applicableProjectTypes: ["LINE"],
          applicableStageCodes: ["S4"],
          status: "PUBLISHED"
        }
      ]
    });
  });
});
