import { describe, expect, it } from "vitest";

import { createHealthStatus } from "./health";

describe("createHealthStatus", () => {
  it("returns an ISO timestamp for the APM service", () => {
    const result = createHealthStatus(new Date("2026-08-02T00:00:00.000Z"));

    expect(result).toEqual({
      service: "apm",
      status: "ok",
      timestamp: "2026-08-02T00:00:00.000Z"
    });
  });
});
