import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /api/notifications", () => {
  it("rejects unauthenticated inbox reads", async () => {
    const response = await GET(new Request("http://localhost/api/notifications"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });
});
