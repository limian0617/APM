import { describe, expect, it } from "vitest";

import { createUphRetestBodySchema, uphRetestPathSchema } from "./uph-retest-http";

describe("APM-084 UPH retest HTTP contract", () => {
  it("requires issue version and never accepts a client topology root", () => {
    expect(
      createUphRetestBodySchema.safeParse({
        issueVersion: 1,
        batchNumber: "RETEST-1",
        plannedProductionSeconds: 3600,
        planDeclarationReason: "new observation",
        observationStartedAt: "2026-09-02T00:00:00Z",
        observationEndedAt: null,
        timezone: "Asia/Shanghai",
        reason: "repeat test"
      }).success
    ).toBe(true);
    expect(
      createUphRetestBodySchema.safeParse({
        issueVersion: 1,
        batchNumber: "RETEST-1",
        topologyRootNodeId: "forged-root",
        plannedProductionSeconds: 3600,
        planDeclarationReason: "new observation",
        observationStartedAt: "2026-09-02T00:00:00Z",
        observationEndedAt: null,
        timezone: "Asia/Shanghai",
        reason: "repeat test"
      }).success
    ).toBe(false);
  });

  it("keeps project and issue in the path", () => {
    expect(uphRetestPathSchema.parse({ projectId: "p1", issueId: "i1" })).toEqual({
      projectId: "p1",
      issueId: "i1"
    });
  });
});
