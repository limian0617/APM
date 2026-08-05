import { describe, expect, it } from "vitest";

import {
  createCorrelationIds,
  normalizeRequestId,
  normalizeTraceId,
  traceIdFromTraceparent
} from "./correlation";

describe("observability correlation identifiers", () => {
  it("accepts bounded request IDs and rejects unsafe values", () => {
    expect(normalizeRequestId("request-123")).toBe("request-123");
    expect(normalizeRequestId("bad request\nvalue")).toBeNull();
    expect(normalizeRequestId("x".repeat(129))).toBeNull();
  });

  it("prefers W3C traceparent and rejects zero or malformed trace IDs", () => {
    expect(traceIdFromTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736"
    );
    expect(normalizeTraceId("00000000000000000000000000000000")).toBeNull();
    expect(normalizeTraceId("not-a-trace")).toBeNull();
  });

  it("generates safe IDs when incoming values are invalid", () => {
    const headers = new Headers({ "x-request-id": "bad id", "x-trace-id": "bad trace" });
    const ids = ["generated-request", "trace-seed"];
    const result = createCorrelationIds(headers, () => ids.shift()!);
    expect(result.requestId).toBe("generated-request");
    expect(result.traceId).toMatch(/^[0-9a-f]{32}$/u);
  });
});
