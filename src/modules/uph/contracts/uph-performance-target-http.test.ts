import { describe, expect, it } from "vitest";

import {
  createUphPerformanceTargetBodySchema,
  publishUphPerformanceTargetBodySchema
} from "./uph-performance-target-http";

describe("APM-084 UPH target HTTP contracts", () => {
  it("accepts only positive target draft fields", () => {
    expect(
      createUphPerformanceTargetBodySchema.safeParse({
        topologyRootNodeId: "root",
        targetUph: "100.000000",
        reason: "baseline"
      }).success
    ).toBe(true);
    expect(
      createUphPerformanceTargetBodySchema.safeParse({
        topologyRootNodeId: "root",
        targetUph: "0",
        reason: "baseline"
      }).success
    ).toBe(false);
  });

  it("rejects forged identity and publish fields", () => {
    expect(
      createUphPerformanceTargetBodySchema.safeParse({
        projectId: "other",
        topologyRootNodeId: "root",
        targetUph: "100",
        reason: "baseline"
      }).success
    ).toBe(false);
    expect(
      publishUphPerformanceTargetBodySchema.safeParse({
        resourceVersion: 1,
        reason: "publish",
        checksum: "x"
      }).success
    ).toBe(false);
  });
});
