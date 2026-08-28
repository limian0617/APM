import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("POST /api/projects/[projectId]/files/uploads", () => {
  it("rejects unauthenticated uploads before object-storage access", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/project-1/files/uploads", {
        method: "POST",
        body: JSON.stringify({ originalName: "test.txt", mimeType: "text/plain", size: 4 })
      }),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });
});
