import { describe, expect, it } from "vitest";

import { POST } from "./route";

const context = { params: Promise.resolve({ projectId: "project-1", issueId: "issue-1" }) };

describe("APM-071 issue relation route", () => {
  it("rejects unauthenticated relation additions before parsing or writing", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/project-1/issues/issue-1/relations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }),
      context
    );

    expect(response.status).toBe(401);
  });
});
