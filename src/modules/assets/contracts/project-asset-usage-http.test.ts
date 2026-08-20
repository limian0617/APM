import { describe, expect, it } from "vitest";

import { parseProjectAssetUsageCreateBody } from "./project-asset-usage-http";

describe("APM-063 project asset usage HTTP contract", () => {
  it("requires an exact release version, scope and idempotency-ready payload", () => {
    expect(
      parseProjectAssetUsageCreateBody({
        usageKey: "usage-1",
        referenceVersion: 1,
        componentSnapshotId: "component-1",
        quantity: "1.250000",
        configuration: { purpose: "FAT" },
        scopeType: "PROJECT",
        scopeId: "project-1",
        reason: "record actual use"
      })
    ).toMatchObject({ scopeType: "PROJECT", quantity: "1.250000", referenceVersion: 1 });
    expect(() => parseProjectAssetUsageCreateBody({ scopeType: "INVALID" })).toThrowError();
    expect(() =>
      parseProjectAssetUsageCreateBody({
        usageKey: "usage-1",
        referenceVersion: 1,
        componentSnapshotId: "component-1",
        quantity: "1.250000",
        configuration: { purpose: "FAT", unexpected: true },
        scopeType: "PROJECT",
        scopeId: "project-1",
        reason: "record actual use"
      })
    ).toThrowError();
  });
});
