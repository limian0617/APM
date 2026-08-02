import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /api/health", () => {
  it("remains dependency-free and returns correlation headers", async () => {
    const response = await GET(
      new Request("http://localhost/api/health", {
        headers: {
          "x-request-id": "health-request",
          "x-trace-id": "4bf92f3577b34da6a3ce929d0e0e4736"
        }
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("health-request");
    expect(response.headers.get("x-trace-id")).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    await expect(response.json()).resolves.toMatchObject({ service: "apm", status: "ok" });
  });
});
