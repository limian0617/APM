import { describe, expect, it } from "vitest";

import { canonicalJson, InvalidEventPayloadError, payloadHash } from "./idempotency";

describe("APM-004 stable event payloads", () => {
  it("canonicalizes object keys recursively without changing array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: [3, 1] } }).serialized).toBe(
      '{"a":{"x":[3,1],"y":2},"z":1}'
    );
  });

  it("produces the same SHA-256 for semantically identical JSON", () => {
    expect(payloadHash({ b: 2, a: 1 }).hash).toBe(payloadHash({ a: 1, b: 2 }).hash);
  });

  it("rejects values that PostgreSQL JSON cannot preserve", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(InvalidEventPayloadError);
    expect(() => canonicalJson({ value: undefined })).toThrow(InvalidEventPayloadError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(InvalidEventPayloadError);
  });
});
