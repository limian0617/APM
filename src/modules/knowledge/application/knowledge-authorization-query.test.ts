import { describe, expect, it, vi } from "vitest";

import {
  KnowledgeAuthorizationQueryError,
  resolveKnowledgeReusePageContext,
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

  it("returns the minimal exact target-project reuse context for correction", async () => {
    const findUnique = vi.fn(async () => ({ id: "reuse-1", version: 2 }));

    await expect(
      resolveKnowledgeReusePageContext(
        { targetProjectId: "target-project-1", reuseId: "reuse-1" },
        { knowledgeReuseRecord: { findUnique } }
      )
    ).resolves.toEqual({
      canCorrectReuse: true,
      reuseContext: { reuseId: "reuse-1", version: 2 }
    });

    expect(findUnique).toHaveBeenCalledWith({
      where: { id_targetProjectId: { id: "reuse-1", targetProjectId: "target-project-1" } },
      select: { id: true, version: true }
    });
  });

  it("does not expose correction availability when the reuse record is missing or belongs elsewhere", async () => {
    const findUnique = vi.fn(async () => null);

    await expect(
      resolveKnowledgeReusePageContext(
        { targetProjectId: "target-project-1", reuseId: "reuse-from-other-project" },
        { knowledgeReuseRecord: { findUnique } }
      )
    ).resolves.toEqual({ canCorrectReuse: false, reuseContext: null });
  });
});
