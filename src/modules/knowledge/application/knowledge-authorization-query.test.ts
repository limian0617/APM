import { describe, expect, it, vi } from "vitest";

import {
  KnowledgeAuthorizationQueryError,
  resolveKnowledgeVersionSourceProject
} from "./knowledge-authorization-query";

describe("knowledge authorization query", () => {
  it("resolves only the source project for an exact entry/version pair", async () => {
    const findUnique = vi.fn(async () => ({ sourceProjectId: "source-project-1" }));

    await expect(
      resolveKnowledgeVersionSourceProject(
        { entryId: "entry-1", versionId: "version-1" },
        { knowledgeEntryVersion: { findUnique } }
      )
    ).resolves.toEqual({ sourceProjectId: "source-project-1" });

    expect(findUnique).toHaveBeenCalledWith({
      where: { id_entryId: { id: "version-1", entryId: "entry-1" } },
      select: { sourceProjectId: true }
    });
  });

  it.each([
    ["unknown entry", "entry-missing", "version-1"],
    ["unknown version", "entry-1", "version-missing"],
    ["entry/version mismatch", "entry-a", "version-b"]
  ])("returns a typed 404 when the %s cannot be resolved", async (_case, entryId, versionId) => {
    const result = resolveKnowledgeVersionSourceProject(
      { entryId, versionId },
      { knowledgeEntryVersion: { findUnique: vi.fn(async () => null) } }
    );

    await expect(result).rejects.toBeInstanceOf(KnowledgeAuthorizationQueryError);
    await expect(result).rejects.toMatchObject({
      code: "KNOWLEDGE_VERSION_NOT_FOUND",
      status: 404
    });
  });
});
