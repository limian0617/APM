import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("POST /api/projects/[projectId]/public-library-references/[referenceId]", () => {
  it("default-denies an unauthenticated retirement command before project or reference lookup", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/project-1/public-library-references/reference-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }),
      { params: Promise.resolve({ projectId: "project-1", referenceId: "reference-1" }) }
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });
});
