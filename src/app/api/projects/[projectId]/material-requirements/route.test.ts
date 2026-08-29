import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("material requirement route", () => {
  it("returns 401 before parsing an unauthenticated request body", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/project-enabled/material-requirements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json"
      }),
      { params: Promise.resolve({ projectId: "project-enabled" }) }
    );
    expect(response.status).toBe(401);
  });
});
