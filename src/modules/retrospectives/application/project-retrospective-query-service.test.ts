import { describe, expect, it, vi } from "vitest";

import { getProjectRetrospective } from "./project-retrospective-query-service";

describe("project retrospective query service", () => {
  it("returns immutable versions, pointers, reviews and allowed actions for the project", async () => {
    const db = {
      projectRetrospective: {
        findUnique: vi.fn().mockResolvedValue({
          id: "retrospective-1",
          projectId: "project-1",
          version: 3,
          currentVersionId: "version-2",
          latestApprovedVersionId: "version-1",
          versions: [
            { id: "version-2", versionNo: 2, status: "DRAFT", contentChecksum: "a".repeat(64) },
            { id: "version-1", versionNo: 1, status: "APPROVED", contentChecksum: "b".repeat(64) }
          ],
          reviews: [{ id: "review-1", retrospectiveVersionId: "version-1", decision: "APPROVED" }]
        })
      }
    };

    await expect(
      getProjectRetrospective({ projectId: "project-1", client: db as any })
    ).resolves.toEqual(
      expect.objectContaining({
        projectId: "project-1",
        currentVersionId: "version-2",
        latestApprovedVersionId: "version-1",
        staleApprovedPointer: true,
        versions: expect.arrayContaining([
          expect.objectContaining({ id: "version-2", status: "DRAFT" })
        ])
      })
    );
  });

  it("returns empty when the project has no retrospective aggregate", async () => {
    const db = { projectRetrospective: { findUnique: vi.fn().mockResolvedValue(null) } };
    await expect(
      getProjectRetrospective({ projectId: "project-1", client: db as any })
    ).resolves.toEqual({
      projectId: "project-1",
      retrospective: null,
      versions: [],
      allowedActions: []
    });
  });
});
