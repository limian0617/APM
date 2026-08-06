import { describe, expect, it } from "vitest";

import { PUT } from "./route";

describe("procurement settings route", () => {
  it("returns 401 before parsing an unauthenticated request body", async () => {
    const response = await PUT(
      new Request("http://localhost/api/projects/project-enabled/procurement/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{not-json"
      }),
      { params: Promise.resolve({ projectId: "project-enabled" }) }
    );
    expect(response.status).toBe(401);
  });
});
