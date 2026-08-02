import { describe, expect, it } from "vitest";

import { nextRetryAt, retryDelaySeconds } from "./job-policy";

describe("APM-004 retry policy", () => {
  const policy = { baseSeconds: 5, maximumSeconds: 60 };

  it("uses capped exponential backoff", () => {
    expect([1, 2, 3, 4, 5].map((attempt) => retryDelaySeconds(attempt, policy))).toEqual([
      5, 10, 20, 40, 60
    ]);
  });

  it("calculates the next eligible database-relative timestamp", () => {
    expect(nextRetryAt(new Date("2026-08-02T00:00:00.000Z"), 3, policy).toISOString()).toBe(
      "2026-08-02T00:00:20.000Z"
    );
  });

  it("rejects invalid retry inputs", () => {
    expect(() => retryDelaySeconds(0, policy)).toThrow(RangeError);
    expect(() => retryDelaySeconds(1, { baseSeconds: 0, maximumSeconds: 10 })).toThrow(RangeError);
  });
});
