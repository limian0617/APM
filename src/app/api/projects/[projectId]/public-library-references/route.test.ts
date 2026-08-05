import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("POST /api/projects/[projectId]/public-library-references", () => {
  it("default-denies an unauthenticated project exact-version reference before lookup", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/project-1/public-library-references", {
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
