import { describe, expect, it } from "vitest";

import { GET, POST } from "./route";

describe("procurement tracking lines route", () => {
  it("returns 401 before parsing an unauthenticated GET query", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/projects/project-enabled/procurement-tracking-lines?limit=not-a-number"
      ),
      { params: Promise.resolve({ projectId: "project-enabled" }) }
    );
    expect(response.status).toBe(401);
  });

  it("returns 401 before parsing an unauthenticated POST body", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/project-enabled/procurement-tracking-lines", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json"
      }),
      { params: Promise.resolve({ projectId: "project-enabled" }) }
    );
    expect(response.status).toBe(401);
  });
});
