import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

describe("APM-104 dev identity route", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns 404 in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await POST(new Request("http://localhost"))).status).toBe(404);
  });
});
