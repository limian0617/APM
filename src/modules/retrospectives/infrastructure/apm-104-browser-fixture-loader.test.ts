import { describe, expect, it } from "vitest";

import { buildApm104BrowserFixture } from "./apm-104-browser-fixture-loader";

describe("APM-104 browser fixture", () => {
  it("returns exact IDs for a disposable V2 workflow without pre-closing it", async () => {
    await expect(
      buildApm104BrowserFixture({
        create: async () => ({
          sourceProjectId: "source-project",
          targetProjectId: "target-project",
          archiveAId: "archive-a",
          users: {
            authorId: "author",
            reviewerId: "reviewer",
            managerId: "manager",
            readerId: "reader"
          }
        })
      })
    ).resolves.toEqual(
      expect.objectContaining({
        sourceProjectId: "source-project",
        archiveAId: "archive-a",
        closed: false,
        workflow: expect.arrayContaining([
          "CREATE_RETROSPECTIVE",
          "SUBMIT_RETROSPECTIVE",
          "REVIEW_RETROSPECTIVE"
        ])
      })
    );
  });
});
