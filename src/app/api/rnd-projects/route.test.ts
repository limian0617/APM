import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("APM-061 R&D project API", () => {
  it("default-denies an unauthenticated R&D project creation request", async () => {
    await expect(
      POST(new Request("http://localhost/api/rnd-projects", { method: "POST" }))
    ).resolves.toMatchObject({ status: 401 });
  });
});
