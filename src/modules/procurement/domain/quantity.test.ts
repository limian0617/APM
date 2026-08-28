import { describe, expect, it } from "vitest";

import { QuantityError, convertQuantity, formatQuantity, parseQuantity } from "./quantity";

describe("APM-091B deterministic quantities", () => {
  it("parses six-decimal quantities without floating point drift", () => {
    expect(parseQuantity("0.1") + parseQuantity("0.2")).toBe(parseQuantity("0.3"));
    expect(formatQuantity(parseQuantity("12.340000"))).toBe("12.34");
    expect(formatQuantity(parseQuantity("0"))).toBe("0");
  });

  it("rejects negative, over-precise and oversized quantities", () => {
    for (const value of ["-1", "1.1234567", "1234567890123", "1e3"]) {
      expect(() => parseQuantity(value)).toThrow(
        expect.objectContaining({ code: "PROC_QUANTITY_INVALID" })
      );
    }
  });

  it("converts only with an exact frozen integer-ratio snapshot", () => {
    expect(
      formatQuantity(convertQuantity(parseQuantity("2"), { numerator: 3n, denominator: 2n }))
    ).toBe("3");
    expect(() =>
      convertQuantity(parseQuantity("0.000001"), { numerator: 1n, denominator: 3n })
    ).toThrow(expect.objectContaining({ code: "PROC_UNIT_CONVERSION_INEXACT" }));
    expect(() => convertQuantity(parseQuantity("1"), { numerator: 0n, denominator: 1n })).toThrow(
      expect.objectContaining({ code: "PROC_UNIT_CONVERSION_INVALID" })
    );
  });

  it("keeps quantity error instances identifiable for callers", () => {
    expect(() => parseQuantity("not-a-quantity")).toThrow(QuantityError);
  });
});
