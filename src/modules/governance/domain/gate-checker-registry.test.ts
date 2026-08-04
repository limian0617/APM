import { describe, expect, it } from "vitest";

import { GATE_CHECKER_REGISTRY, resolveGateChecker } from "./gate-checker-registry";

describe("APM-031 Gate checker registry", () => {
  it("resolves registered checkers by their stable code and version", () => {
    expect(resolveGateChecker("STAGE.AWAITING_GATE", 1)).toMatchObject({
      code: "STAGE.AWAITING_GATE",
      version: 1
    });
    expect(GATE_CHECKER_REGISTRY.size).toBe(2);
    expect(resolveGateChecker("STAGE.AWAITING_GATE", 2)).toBeUndefined();
  });

  it("evaluates the technical stage checker from supplied stage facts without database access", () => {
    const checker = resolveGateChecker("STAGE.AWAITING_GATE", 1);

    expect(
      checker?.evaluate({
        projectId: "project-1",
        gateCode: "G1",
        stageCode: "S0",
        scope: "PROJECT",
        stageStatus: "AWAITING_GATE"
      })
    ).toMatchObject({ status: "PASSED", code: "STAGE_AWAITING_GATE" });
  });

  it("returns a deterministic hard failure while the Documents dependency is unavailable", () => {
    const checker = resolveGateChecker("DOCUMENTS.COMPLETE", 1);

    expect(
      checker?.evaluate({
        projectId: "project-1",
        gateCode: "G1",
        stageCode: "S0",
        scope: "PROJECT",
        stageStatus: "AWAITING_GATE"
      })
    ).toMatchObject({
      status: "HARD_FAILED",
      code: "CHECKER_DEPENDENCY_UNAVAILABLE",
      evidence: { dependency: "DOCUMENTS" }
    });
  });
});
