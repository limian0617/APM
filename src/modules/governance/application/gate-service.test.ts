import { describe, expect, it } from "vitest";

import {
  GateServiceError,
  buildGateCheckRun,
  evaluateFrozenGateCheckers,
  resolveGateStageStatus,
  validateGateInstanceScopeTarget
} from "./gate-service";

function expectGateError(operation: () => unknown, code: string, status: number) {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code, status });
    return;
  }
  throw new Error(`Expected ${code} GateServiceError.`);
}

describe("APM-031 Gate service rules", () => {
  it("requires an explicit target whose shape matches a non-project Gate scope", () => {
    expect(
      validateGateInstanceScopeTarget({
        scope: "DELIVERY_UNIT",
        deliveryUnitId: "unit-1",
        moduleId: null
      })
    ).toEqual({ scope: "DELIVERY_UNIT", deliveryUnitId: "unit-1", moduleId: null });
    expect(
      validateGateInstanceScopeTarget({
        scope: "MODULE",
        deliveryUnitId: "unit-1",
        moduleId: "module-1"
      })
    ).toEqual({ scope: "MODULE", deliveryUnitId: "unit-1", moduleId: "module-1" });

    expectGateError(
      () =>
        validateGateInstanceScopeTarget({ scope: "PROJECT", deliveryUnitId: null, moduleId: null }),
      "GATE_PROJECT_INSTANCE_MANUAL_FORBIDDEN",
      409
    );
    expectGateError(
      () =>
        validateGateInstanceScopeTarget({
          scope: "DELIVERY_UNIT",
          deliveryUnitId: null,
          moduleId: null
        }),
      "GATE_SCOPE_TARGET_INVALID",
      422
    );
    expectGateError(
      () =>
        validateGateInstanceScopeTarget({
          scope: "DELIVERY_UNIT",
          deliveryUnitId: "unit-1",
          moduleId: "module-1"
        }),
      "GATE_SCOPE_TARGET_INVALID",
      422
    );
    expectGateError(
      () =>
        validateGateInstanceScopeTarget({
          scope: "MODULE",
          deliveryUnitId: "unit-1",
          moduleId: null
        }),
      "GATE_SCOPE_TARGET_INVALID",
      422
    );
  });

  it("turns a missing exact checker version and an unsupported scope into ordered hard failures", () => {
    const results = evaluateFrozenGateCheckers(
      {
        projectId: "project-1",
        gateCode: "G1",
        stageCode: "S0",
        stageStatus: "AWAITING_GATE",
        scope: "MODULE",
        checkerBindings: [
          { code: "MISSING.CHECKER", version: 7 },
          { code: "PROJECT.ONLY", version: 1 }
        ]
      },
      (code, version) =>
        code === "PROJECT.ONLY" && version === 1
          ? {
              code,
              version,
              supportedScopes: ["PROJECT"] as const,
              evaluate: () => ({
                status: "PASSED" as const,
                code: "PROJECT_ONLY_PASSED",
                message: "not reached",
                evidence: {}
              })
            }
          : undefined
    );

    expect(results).toEqual([
      expect.objectContaining({
        position: 0,
        checkerCode: "MISSING.CHECKER",
        checkerVersion: 7,
        status: "HARD_FAILED",
        failureCode: "CHECKER_NOT_REGISTERED"
      }),
      expect.objectContaining({
        position: 1,
        checkerCode: "PROJECT.ONLY",
        checkerVersion: 1,
        status: "HARD_FAILED",
        failureCode: "CHECKER_SCOPE_UNSUPPORTED"
      })
    ]);
  });

  it("uses a delivery-unit stage for delivery-unit and module Gate readiness", () => {
    expect(
      resolveGateStageStatus({
        scope: "PROJECT",
        projectStageStatus: "AWAITING_GATE",
        deliveryUnitStageStatus: "NOT_STARTED"
      })
    ).toBe("AWAITING_GATE");
    expect(
      resolveGateStageStatus({
        scope: "DELIVERY_UNIT",
        projectStageStatus: "NOT_STARTED",
        deliveryUnitStageStatus: "AWAITING_GATE"
      })
    ).toBe("AWAITING_GATE");
    expect(
      resolveGateStageStatus({
        scope: "MODULE",
        projectStageStatus: "NOT_STARTED",
        deliveryUnitStageStatus: "AWAITING_GATE"
      })
    ).toBe("AWAITING_GATE");
  });

  it("freezes checker order, canonical checksums, and the hard-failure aggregate", () => {
    const input = {
      projectId: "project-1",
      instanceId: "instance-1",
      definition: {
        code: "G1",
        name: "Baseline Gate",
        projectStageId: "stage-1",
        definitionJson: { name: "Baseline Gate", code: "G1" }
      },
      scope: { scope: "DELIVERY_UNIT" as const, deliveryUnitId: "unit-1", moduleId: null },
      stage: { code: "S0", status: "AWAITING_GATE" as const },
      checkerBindings: [
        { code: "STAGE.AWAITING_GATE", version: 1 },
        { code: "DOCUMENTS.COMPLETE", version: 1 }
      ],
      reason: "Run frozen Gate checks"
    };

    const first = buildGateCheckRun(input);
    const second = buildGateCheckRun({
      ...input,
      definition: { ...input.definition, definitionJson: { code: "G1", name: "Baseline Gate" } }
    });

    expect(first).toMatchObject({
      overallStatus: "HARD_FAILED",
      results: [
        { position: 0, status: "PASSED", failureCode: null },
        {
          position: 1,
          status: "HARD_FAILED",
          failureCode: "CHECKER_DEPENDENCY_UNAVAILABLE"
        }
      ]
    });
    expect(second.inputChecksum).toBe(first.inputChecksum);
    expect(second.resultChecksum).toBe(first.resultChecksum);
    expect(first.results.map((result) => result.evidenceChecksum)).toEqual(
      second.results.map((result) => result.evidenceChecksum)
    );
  });

  it("uses a typed error suitable for non-leaking HTTP mapping", () => {
    const error = new GateServiceError("GATE_INSTANCE_NOT_FOUND", "not found", 404);
    expect(error).toMatchObject({
      code: "GATE_INSTANCE_NOT_FOUND",
      status: 404,
      name: "GateServiceError"
    });
  });
});
