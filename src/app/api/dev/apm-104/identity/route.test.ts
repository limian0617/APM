import { afterEach, describe, expect, it, vi } from "vitest";

const tokens = vi.hoisted(() => ({ consumeApm104BrowserIdentityToken: vi.fn() }));
vi.mock("@/modules/retrospectives/infrastructure/apm-104-browser-fixture-loader", () => tokens);
import { POST } from "./route";

describe("APM-104 dev identity route", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns 404 in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await POST(new Request("http://localhost"))).status).toBe(404);
  });

  it("exchanges a fixture token once into an HttpOnly development cookie", async () => {
    vi.stubEnv("NODE_ENV", "test");
    tokens.consumeApm104BrowserIdentityToken
      .mockReturnValueOnce("source-manager")
      .mockReturnValue(null);
    const request = () =>
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityToken: "one-time" })
      });

    const first = await POST(request());
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie")).toContain("HttpOnly");
    expect(first.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(first.headers.get("set-cookie")).toContain("Path=/");
    expect(first.headers.get("set-cookie")).not.toContain("Secure");
    expect((await POST(request())).status).toBe(422);
  });
});
