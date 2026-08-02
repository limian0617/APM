import { describe, expect, it } from "vitest";

import { checkReadiness } from "./readiness";

describe("checkReadiness", () => {
  it("reports ready only when every dependency is ready", async () => {
    const result = await checkReadiness({
      probes: [
        { name: "database", async check() {} },
        { name: "migrations", async check() {} }
      ],
      now: new Date("2026-08-02T00:00:00.000Z")
    });
    expect(result).toEqual({
      service: "apm",
      status: "ready",
      timestamp: "2026-08-02T00:00:00.000Z",
      checks: [
        { name: "database", status: "ready", code: null },
        { name: "migrations", status: "ready", code: null }
      ]
    });
  });

  it("returns a safe degraded result without exposing dependency errors", async () => {
    const result = await checkReadiness({
      probes: [
        {
          name: "database",
          async check() {
            throw new Error("postgresql://user:secret@production/internal");
          }
        }
      ],
      now: new Date("2026-08-02T00:00:00.000Z")
    });
    expect(result).toMatchObject({
      status: "not_ready",
      checks: [{ name: "database", status: "not_ready", code: "DEPENDENCY_UNAVAILABLE" }]
    });
    expect(JSON.stringify(result)).not.toContain("production");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
