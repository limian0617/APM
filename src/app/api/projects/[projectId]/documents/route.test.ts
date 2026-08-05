import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("POST /api/projects/[projectId]/documents", () => {
  it("rejects an unauthenticated controlled-document command before any document lookup", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/project-1/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });
});
