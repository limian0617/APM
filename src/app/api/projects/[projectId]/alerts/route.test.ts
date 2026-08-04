import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /api/projects/[projectId]/alerts", () => {
  it("rejects unauthenticated alert reads before querying project facts", async () => {
    const response = await GET(
      new Request("http://localhost/api/projects/project-1/alerts", { method: "GET" }),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });
});
