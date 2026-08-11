import { describe, expect, it } from "vitest";

import { GATE_CHECKER_REGISTRY, resolveGateChecker } from "./gate-checker-registry";

describe("APM-031 Gate checker registry", () => {
  it("resolves registered checkers by their stable code and version", () => {
    expect(resolveGateChecker("STAGE.AWAITING_GATE", 1)).toMatchObject({
      code: "STAGE.AWAITING_GATE",
      version: 1
    });
    expect(GATE_CHECKER_REGISTRY.size).toBe(8);
    expect(resolveGateChecker("CLOSURE.ARCHIVE.G9", 1)).toMatchObject({
      code: "CLOSURE.ARCHIVE.G9",
      version: 1
    });
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

  it("evaluates frozen procurement readiness facts without database access", () => {
    const checker = resolveGateChecker("PROCUREMENT.READINESS", 1);

    expect(
      checker?.evaluate({
        projectId: "project-1",
        gateCode: "G3",
        stageCode: "S3",
        scope: "PROJECT",
        stageStatus: "AWAITING_GATE",
        facts: {
          procurementReadiness: {
            readinessResultId: "readiness-1",
            policyVersion: "policy-3",
            formulaVersion: "PROCUREMENT.READINESS@1",
            inputWatermark: "watermark-1",
            calculatedAt: "2026-08-07T00:00:00.000Z",
            status: "READY",
            criticalGapLines: 0,
            gapLines: 0,
            affectedRequirementIds: [],
            changeFactsAvailability: "AVAILABLE",
            gateThreshold: { warningGapLines: 1, hardFailureGapLines: 2 }
          }
        }
      })
    ).toMatchObject({
      status: "PASSED",
      code: "PROCUREMENT_READINESS_PASSED",
      evidence: {
        readinessResultId: "readiness-1",
        policyVersion: "policy-3",
        formulaVersion: "PROCUREMENT.READINESS@1",
        inputWatermark: "watermark-1",
        calculatedAt: "2026-08-07T00:00:00.000Z",
        criticalGapLines: 0,
        affectedRequirementIds: []
      }
    });
  });

  it("fails closed for missing, invalid, stale, critical, drawing, and major-change procurement facts", () => {
    const checker = resolveGateChecker("PROCUREMENT.READINESS", 1);
    const base = {
      readinessResultId: "readiness-1",
      policyVersion: "policy-3",
      formulaVersion: "PROCUREMENT.READINESS@1",
      inputWatermark: "watermark-1",
      calculatedAt: "2026-08-07T00:00:00.000Z",
      status: "READY",
      criticalGapLines: 0,
      gapLines: 0,
      affectedRequirementIds: [],
      changeFactsAvailability: "AVAILABLE",
      gateThreshold: { warningGapLines: 1, hardFailureGapLines: 2 }
    };
    const failures = [
      undefined,
      { ...base, status: "NOT_CALCULATED" },
      { ...base, status: "INVALID_INPUT" },
      { ...base, status: "STALE" },
      { ...base, status: "BLOCKED", criticalGapLines: 1, affectedRequirementIds: ["critical-1"] },
      { ...base, wrongDrawingVersionRequirementIds: ["drawing-1"] },
      { ...base, unresolvedMajorChangeRequirementIds: ["change-1"] }
    ];

    for (const procurementReadiness of failures) {
      expect(
        checker?.evaluate({
          projectId: "project-1",
          gateCode: "G3",
          stageCode: "S3",
          scope: "PROJECT",
          stageStatus: "AWAITING_GATE",
          facts: procurementReadiness === undefined ? {} : { procurementReadiness }
        })
      ).toMatchObject({ status: "HARD_FAILED" });
    }
  });

  it("hard-fails when procurement change facts are unavailable instead of treating them as no impacts", () => {
    const checker = resolveGateChecker("PROCUREMENT.READINESS", 1);
    const result = checker?.evaluate({
      projectId: "project-1",
      gateCode: "G3",
      stageCode: "S3",
      scope: "PROJECT",
      stageStatus: "AWAITING_GATE",
      facts: {
        procurementReadiness: {
          readinessResultId: "readiness-1",
          policyVersion: "policy-3",
          formulaVersion: "PROCUREMENT.READINESS@1",
          inputWatermark: "watermark-1",
          calculatedAt: "2026-08-07T00:00:00.000Z",
          status: "READY",
          criticalGapLines: 0,
          gapLines: 0,
          affectedRequirementIds: [],
          wrongDrawingVersionRequirementIds: [],
          unresolvedMajorChangeRequirementIds: [],
          changeFactsAvailability: "UNAVAILABLE",
          gateThreshold: { warningGapLines: 1, hardFailureGapLines: 2 }
        }
      }
    });

    expect(result).toMatchObject({
      status: "HARD_FAILED",
      code: "PROCUREMENT_CHANGE_FACTS_UNAVAILABLE"
    });
  });

  it("prioritizes unavailable change facts over incomplete readiness snapshot fields", () => {
    const checker = resolveGateChecker("PROCUREMENT.READINESS", 1);
    const result = checker?.evaluate({
      projectId: "project-1",
      gateCode: "G3",
      stageCode: "S3",
      scope: "PROJECT",
      stageStatus: "AWAITING_GATE",
      facts: {
        procurementReadiness: {
          readinessResultId: null,
          policyVersion: null,
          formulaVersion: null,
          inputWatermark: null,
          calculatedAt: null,
          status: "NOT_CALCULATED",
          criticalGapLines: 0,
          gapLines: 0,
          affectedRequirementIds: [],
          wrongDrawingVersionRequirementIds: [],
          unresolvedMajorChangeRequirementIds: [],
          changeFactsAvailability: "UNAVAILABLE",
          gateThreshold: null
        }
      }
    });

    expect(result).toMatchObject({
      status: "HARD_FAILED",
      code: "PROCUREMENT_CHANGE_FACTS_UNAVAILABLE"
    });
  });

  it("uses frozen procurement gap thresholds for warnings and hard failures", () => {
    const checker = resolveGateChecker("PROCUREMENT.READINESS", 1);
    const evaluate = (gapLines: number) =>
      checker?.evaluate({
        projectId: "project-1",
        gateCode: "G3",
        stageCode: "S3",
        scope: "PROJECT",
        stageStatus: "AWAITING_GATE",
        facts: {
          procurementReadiness: {
            readinessResultId: "readiness-1",
            policyVersion: "policy-3",
            formulaVersion: "PROCUREMENT.READINESS@1",
            inputWatermark: "watermark-1",
            calculatedAt: "2026-08-07T00:00:00.000Z",
            status: "BLOCKED",
            criticalGapLines: 0,
            gapLines,
            affectedRequirementIds: ["ordinary-1"],
            changeFactsAvailability: "AVAILABLE",
            gateThreshold: { warningGapLines: 1, hardFailureGapLines: 2 }
          }
        }
      });

    expect(evaluate(1)).toMatchObject({ status: "WARNING", code: "PROCUREMENT_READINESS_WARNING" });
    expect(evaluate(2)).toMatchObject({
      status: "HARD_FAILED",
      code: "PROCUREMENT_READINESS_GAP_HARD_FAILED"
    });
  });

  it("registers separate versioned FAT and SAT acceptance issue checkers", () => {
    const fat = resolveGateChecker("ACCEPTANCE.FAT.ISSUES", 1);
    const sat = resolveGateChecker("ACCEPTANCE.SAT.ISSUES", 1);
    expect(fat).toMatchObject({ code: "ACCEPTANCE.FAT.ISSUES", version: 1 });
    expect(sat).toMatchObject({ code: "ACCEPTANCE.SAT.ISSUES", version: 1 });
    expect(
      fat?.evaluate({
        projectId: "project-1",
        gateCode: "G6",
        stageCode: "S6",
        scope: "PROJECT",
        stageStatus: "AWAITING_GATE",
        facts: {
          acceptanceIssues: {
            acceptanceType: "FAT",
            factsAvailable: true,
            sourceChecksum: "sha256:facts",
            requiredResultMissing: false,
            results: [
              { resultRevisionId: "r-1", itemCode: "POWER", decision: "FAIL", issueIds: [] }
            ],
            issues: [],
            retestPassRevisionIds: []
          }
        }
      })
    ).toMatchObject({ status: "HARD_FAILED", code: "ACCEPTANCE_FAIL_ISSUE_UNLINKED" });
  });

  it("registers separate versioned FAT and SAT confirmation checkers without changing issue checkers", () => {
    const fat = resolveGateChecker("ACCEPTANCE.FAT.CONFIRMATION", 1);
    const sat = resolveGateChecker("ACCEPTANCE.SAT.CONFIRMATION", 1);
    expect(fat).toMatchObject({ code: "ACCEPTANCE.FAT.CONFIRMATION", version: 1 });
    expect(sat).toMatchObject({ code: "ACCEPTANCE.SAT.CONFIRMATION", version: 1 });
    expect(resolveGateChecker("ACCEPTANCE.FAT.ISSUES", 1)).toMatchObject({
      code: "ACCEPTANCE.FAT.ISSUES",
      version: 1
    });
  });
});
