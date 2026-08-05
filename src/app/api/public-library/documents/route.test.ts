import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("POST /api/public-library/documents", () => {
  it("default-denies an unauthenticated enterprise-library command before parsing payload", async () => {
    const response = await POST(
      new Request("http://localhost/api/public-library/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });
});
