import { describe, expect, it } from "vitest";

import {
  assertActiveProjectAssetUsage,
  assertReferenceCanRetire,
  canonicalProjectAssetConfiguration,
  parseProjectAssetQuantity,
  ProjectAssetUsageError,
  PROJECT_ASSET_USAGE_SCOPE_TYPES,
  type ProjectAssetUsageScopeType
} from "./project-asset-usage";

describe("APM-063 project asset usage domain", () => {
  it("accepts a positive NUMERIC(20,6) quantity and rejects invalid precision", () => {
    expect(parseProjectAssetQuantity("12.345678")).toBe("12.345678");
    expect(parseProjectAssetQuantity("1.250000")).toBe("1.25");
    expect(() => parseProjectAssetQuantity("0")).toThrowError(/正数/);
    expect(() => parseProjectAssetQuantity("1.2345678")).toThrowError(/6/);
    expect(() => parseProjectAssetQuantity("123456789012345")).toThrowError(/14/);
    expect(() => parseProjectAssetQuantity("Infinity")).toThrowError();
  });

  it("canonicalizes configuration objects without sorting arrays", () => {
    expect(
      canonicalProjectAssetConfiguration({ b: 1, a: { z: true, y: ["second", "first"] } })
    ).toEqual({
      serialized: '{"a":{"y":["second","first"],"z":true},"b":1}',
      value: { a: { y: ["second", "first"], z: true }, b: 1 }
    });
    expect(() => canonicalProjectAssetConfiguration([])).toThrowError(/对象/);
    expect(() => canonicalProjectAssetConfiguration({ value: -0 })).toThrowError(/-0/);
  });

  it("uses explicit scope values and permits only ACTIVE to RETIRED", () => {
    expect(PROJECT_ASSET_USAGE_SCOPE_TYPES).toEqual(["PROJECT", "DELIVERY_UNIT", "MODULE"]);
    expect(() => assertActiveProjectAssetUsage("RETIRED")).toThrowError(/ACTIVE/);
    expect(() => assertReferenceCanRetire({ activeUsageCount: 1 })).toThrowError(
      ProjectAssetUsageError
    );
    try {
      assertReferenceCanRetire({ activeUsageCount: 1 });
    } catch (error) {
      expect((error as ProjectAssetUsageError).code).toBe(
        "PROJECT_ASSET_REFERENCE_HAS_ACTIVE_USAGE"
      );
    }
    expect(() => assertReferenceCanRetire({ activeUsageCount: 0 })).not.toThrow();
    const scope: ProjectAssetUsageScopeType = "MODULE";
    expect(scope).toBe("MODULE");
  });
});
