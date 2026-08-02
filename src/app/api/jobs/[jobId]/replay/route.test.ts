import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("POST /api/jobs/[jobId]/replay", () => {
  it("rejects an unauthenticated replay before looking up the job", async () => {
    const response = await POST(
      new Request("http://localhost/api/jobs/unknown/replay", {
        method: "POST",
        body: JSON.stringify({ reason: "test" })
      }),
      { params: Promise.resolve({ jobId: "unknown" }) }
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNAUTHENTICATED" }
    });
  });
});
