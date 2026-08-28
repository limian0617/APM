import { describe, expect, it, vi } from "vitest";

import { createKnowledgeSearchRepository } from "./knowledge-repository";

describe("knowledge search repository", () => {
  it("queries only an active entry's exact current published version", async () => {
    let sqlText = "";
    const client = {
      $queryRaw: vi.fn(async (query: { strings?: readonly string[] }) => {
        sqlText = query.strings?.join("") ?? "";
        return [];
      })
    };

    await createKnowledgeSearchRepository(client as never).searchPublishedBoundedIlike({
      query: "servo",
      skip: 0,
      take: 20,
      maxWindow: 100
    });

    expect(sqlText).toContain("e.status = 'ACTIVE'::\"KnowledgeEntryStatus\"");
    expect(sqlText).toContain("e.current_published_version_id = v.id");
  });
});
