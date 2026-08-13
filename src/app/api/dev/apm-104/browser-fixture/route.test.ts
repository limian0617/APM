import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

describe("APM-104 browser fixture route", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns 404 outside development or test", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await POST()).status).toBe(404);
  });
});
