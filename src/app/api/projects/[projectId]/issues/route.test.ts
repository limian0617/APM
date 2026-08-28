import { describe, expect, it } from "vitest";

import { GET, POST } from "./route";

const context = { params: Promise.resolve({ projectId: "project-1" }) };

describe("APM-070 project issue routes", () => {
  it("rejects unauthenticated reads before querying issue facts", async () => {
    const response = await GET(
      new Request("http://localhost/api/projects/project-1/issues", { method: "GET" }),
      context
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });

  it("rejects unauthenticated issue creation before parsing or writing the command", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/project-1/issues", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }),
      context
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });
});
