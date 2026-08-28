import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("reserved /api/external/v1 boundary", () => {
  it("does not expose an internal business API and returns correlated 404", async () => {
    const response = await GET(
      new Request("http://localhost/api/external/v1/supplier-packages", {
        headers: { "x-request-id": "external-contract-test" }
      })
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "EXTERNAL_API_NOT_AVAILABLE",
        issues: [],
        requestId: "external-contract-test",
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/u)
      }
    });
  });
});
