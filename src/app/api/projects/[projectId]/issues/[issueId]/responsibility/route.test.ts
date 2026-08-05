import { describe, expect, it } from "vitest";

import { PUT } from "./route";

const context = { params: Promise.resolve({ projectId: "project-1", issueId: "issue-1" }) };

describe("APM-071 issue responsibility route", () => {
  it("rejects unauthenticated responsibility changes before parsing or writing", async () => {
    const response = await PUT(
      new Request("http://localhost/api/projects/project-1/issues/issue-1/responsibility", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }),
      context
    );

    expect(response.status).toBe(401);
  });
});
