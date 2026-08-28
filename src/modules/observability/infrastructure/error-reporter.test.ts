import { describe, expect, it } from "vitest";

import type { ObservabilityContext } from "../contracts/telemetry";
import { createErrorReport, MemoryErrorReporter } from "./error-reporter";

const context: ObservabilityContext = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  requestId: "request-1",
  jobId: null,
  actorId: "user-1",
  projectId: null,
  module: "test",
  operation: "report"
};

describe("error reporting", () => {
  it("creates a stable fingerprint and removes secrets before capture", async () => {
    const first = createErrorReport(new Error("Bearer secret-token failed"), context, {
      password: "do-not-store"
    });
    const second = createErrorReport(new Error("Bearer secret-token failed"), context, {
      password: "another-secret"
    });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.message).toBe("Bearer [REDACTED] failed");
    expect(first.metadata).toEqual({ password: "[REDACTED]" });

    const reporter = new MemoryErrorReporter();
    await reporter.capture(first);
    expect(reporter.reports).toEqual([first]);
  });
});
