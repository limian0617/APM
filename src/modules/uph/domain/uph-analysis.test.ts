import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  analyzeLockedUph,
  CANONICAL_UPH_FORMULA,
  type LockedUphAnalysisInput,
  UPH_ANALYSIS_ENGINE
} from "./uph-analysis";

const checksum = (character: string) => character.repeat(64);

function clone(input: LockedUphAnalysisInput): LockedUphAnalysisInput {
  return JSON.parse(JSON.stringify(input)) as LockedUphAnalysisInput;
}

function requireComputed(input: LockedUphAnalysisInput) {
  const result = analyzeLockedUph(input);
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join(", "));
  return result;
}

function nestedFixture(): LockedUphAnalysisInput {
  const topologyNodes: LockedUphAnalysisInput["topologyNodes"] = [
    {
      id: "line",
      parentNodeId: null,
      parentRelation: "ROOT",
      topologyPath: "/line",
      sourceType: "DELIVERY_UNIT",
      sourceId: "line-1"
    },
    {
      id: "machine-a",
      parentNodeId: "line",
      parentRelation: "MANDATORY",
      topologyPath: "/line/machine-a",
      sourceType: "DELIVERY_UNIT",
      sourceId: "machine-a"
    },
    {
      id: "module-a",
      parentNodeId: "machine-a",
      parentRelation: "MANDATORY",
      topologyPath: "/line/machine-a/module-a",
      sourceType: "PROJECT_MODULE",
      sourceId: "module-a"
    },
    {
      id: "module-b",
      parentNodeId: "machine-a",
      parentRelation: "PARALLEL",
      topologyPath: "/line/machine-a/module-b",
      sourceType: "PROJECT_MODULE",
      sourceId: "module-b"
    },
    {
      id: "module-c",
      parentNodeId: "machine-a",
      parentRelation: "PARALLEL",
      topologyPath: "/line/machine-a/module-c",
      sourceType: "PROJECT_MODULE",
      sourceId: "module-c"
    },
    {
      id: "machine-b",
      parentNodeId: "line",
      parentRelation: "MANDATORY",
      topologyPath: "/line/machine-b",
      sourceType: "DELIVERY_UNIT",
      sourceId: "machine-b"
    },
    {
      id: "module-d",
      parentNodeId: "machine-b",
      parentRelation: "MANDATORY",
      topologyPath: "/line/machine-b/module-d",
      sourceType: "PROJECT_MODULE",
      sourceId: "module-d"
    },
    {
      id: "module-e",
      parentNodeId: "machine-b",
      parentRelation: "PARALLEL",
      topologyPath: "/line/machine-b/module-e",
      sourceType: "PROJECT_MODULE",
      sourceId: "module-e"
    },
    {
      id: "module-f",
      parentNodeId: "machine-b",
      parentRelation: "PARALLEL",
      topologyPath: "/line/machine-b/module-f",
      sourceType: "PROJECT_MODULE",
      sourceId: "module-f"
    },
    {
      id: "machine-c",
      parentNodeId: "line",
      parentRelation: "MANDATORY",
      topologyPath: "/line/machine-c",
      sourceType: "DELIVERY_UNIT",
      sourceId: "machine-c"
    },
    {
      id: "module-g",
      parentNodeId: "machine-c",
      parentRelation: "MANDATORY",
      topologyPath: "/line/machine-c/module-g",
      sourceType: "PROJECT_MODULE",
      sourceId: "module-g"
    }
  ];
  const p90ByNode: Record<string, string> = {
    "module-a": "3.000000",
    "module-b": "4.000000",
    "module-c": "4.000000",
    "module-d": "3.000000",
    "module-e": "6.000000",
    "module-f": "6.000000",
    "module-g": "2.000000"
  };
  return {
    engineCode: UPH_ANALYSIS_ENGINE,
    formulaCode: CANONICAL_UPH_FORMULA,
    lockedChecksum: checksum("a"),
    confirmedInputChecksum: checksum("b"),
    statisticsChecksum: checksum("c"),
    minimumIncludedSampleCount: "10",
    topologyRootNodeId: "line",
    topologyNodes,
    leaves: Object.entries(p90ByNode).map(([topologyNodeId, p90Seconds]) => ({
      topologyNodeId,
      p90Seconds,
      intrinsicCtSeconds: topologyNodeId === "module-a" ? "3.100000" : p90Seconds,
      outputPerCycleTotal: "1",
      parallelChannelCount: "1",
      cavityCount: "2",
      includedSampleCount: "10"
    })),
    rootProduction: {
      actualGrossOutputCount: "100",
      finalGoodOutputCount: "90",
      plannedProductionSeconds: "3600"
    },
    moduleQuality: Object.keys(p90ByNode).map((moduleId) => ({
      moduleId,
      qualityInputCount: moduleId === "module-f" ? "0" : "2000000",
      firstPassGoodCount: moduleId === "module-a" ? "1" : "0"
    }))
  };
}

describe("APM-082 locked UPH deterministic analysis", () => {
  it("keeps the frozen engine in the exact BigInt / HALF_UP numeric boundary", () => {
    const source = readFileSync(new URL("./uph-analysis.ts", import.meta.url), "utf8");

    for (const required of [
      "UPH_ANALYSIS@1",
      "CANONICAL_UPH_V1",
      "BigInt",
      "HALF_UP",
      "numeric(20,6)",
      "P90",
      "MANDATORY",
      "PARALLEL",
      "bottleneck"
    ]) {
      expect(source).toContain(required);
    }
    expect(source).not.toContain("Number(");
  });

  it("reduces the exact topology bottom-up and scopes PARALLEL sums to their direct parent", () => {
    const result = requireComputed(nestedFixture());
    const machineA = result.reductionLevels.find((level) => level.nodeId === "machine-a");
    const machineB = result.reductionLevels.find((level) => level.nodeId === "machine-b");

    expect(result.rootMeasuredCapacityUph).toBe("1200.000000");
    expect(result.bottleneck.map((candidate) => candidate.sourceId)).toEqual([
      "machine-a",
      "machine-b"
    ]);
    expect(result.secondBottleneck?.map((candidate) => candidate.sourceId)).toEqual(["machine-c"]);
    expect(
      machineA?.candidates.find((candidate) => candidate.relation === "PARALLEL")
    ).toMatchObject({
      parallelGroupId: "machine-a",
      capacityUph: "1800.000000"
    });
    expect(
      machineB?.candidates.find((candidate) => candidate.relation === "PARALLEL")
    ).toMatchObject({
      parallelGroupId: "machine-b",
      capacityUph: "1200.000000"
    });
    expect(
      machineB?.candidates.filter((candidate) => candidate.capacityUph === "1200.000000")
    ).toHaveLength(2);
    expect(machineA?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          exactComparisonValue: "1200/1",
          members: [
            {
              topologyPath: "/line/machine-a/module-a",
              sourceType: "PROJECT_MODULE",
              sourceId: "module-a"
            }
          ]
        })
      ])
    );
    expect(machineA?.selectedCapacityExact).toBe("1200/1");
    expect(result.rootFpy).toBe("NOT_APPLICABLE");
    expect(result.capacityTimesATimesFpy).toBe("NOT_APPLICABLE");
    expect(result.moduleFpy.find((item) => item.moduleId === "module-a")?.fpy).toBe("0.000001");
    expect(result.warnings).toEqual([
      "MEASURED_CAPACITY_GT_INTRINSIC:PROJECT_MODULE:module-a",
      "NO_QUALITY_INPUT:module-f"
    ]);
  });

  it("serializes semantically identical frozen input in one canonical order", () => {
    const input = nestedFixture();
    const permuted = clone(input);
    permuted.topologyNodes.reverse();
    permuted.leaves.reverse();
    permuted.moduleQuality.reverse();

    expect(requireComputed(permuted)).toEqual(requireComputed(input));
  });

  it("keeps NO_OUTPUT, A_GT_ONE and no-quality warnings deterministic without inventing root FPY", () => {
    const noOutput = nestedFixture();
    noOutput.rootProduction = {
      actualGrossOutputCount: "0",
      finalGoodOutputCount: "0",
      plannedProductionSeconds: "3600"
    };
    const noOutputResult = requireComputed(noOutput);
    expect(noOutputResult.status).toBe("NO_OUTPUT");
    expect(noOutputResult.actualGoodUph).toBe("0.000000");
    expect(noOutputResult.A).toBe("0.000000");
    expect(noOutputResult.warnings).toContain("NO_OUTPUT");

    const overCapacity = nestedFixture();
    overCapacity.rootProduction.actualGrossOutputCount = "2000";
    overCapacity.rootProduction.finalGoodOutputCount = "2000";
    expect(requireComputed(overCapacity).warnings).toContain("A_GT_ONE");
  });

  it("rejects malformed frozen facts, topology ambiguity, cycles, and unavailable statistics", () => {
    const malformedChecksum = nestedFixture();
    malformedChecksum.lockedChecksum = checksum("A");
    expect(analyzeLockedUph(malformedChecksum)).toMatchObject({ ok: false });

    const truncatedChecksum = nestedFixture();
    truncatedChecksum.statisticsChecksum = checksum("c").slice(1);
    expect(analyzeLockedUph(truncatedChecksum)).toMatchObject({ ok: false });

    const duplicateModule = nestedFixture();
    duplicateModule.moduleQuality[1]!.moduleId = "module-a";
    expect(analyzeLockedUph(duplicateModule)).toMatchObject({ ok: false });

    const duplicateSource = nestedFixture();
    duplicateSource.topologyNodes.find((node) => node.id === "module-b")!.sourceId = "module-a";
    expect(analyzeLockedUph(duplicateSource)).toMatchObject({ ok: false });

    const brokenParent = nestedFixture();
    brokenParent.topologyNodes.find((node) => node.id === "machine-a")!.parentNodeId = "missing";
    expect(analyzeLockedUph(brokenParent)).toMatchObject({ ok: false });

    const cycle = nestedFixture();
    cycle.topologyNodes.find((node) => node.id === "machine-a")!.parentNodeId = "module-a";
    expect(analyzeLockedUph(cycle)).toMatchObject({ ok: false });

    const multipleRoots = nestedFixture();
    const machineC = multipleRoots.topologyNodes.find((node) => node.id === "machine-c")!;
    machineC.parentNodeId = null;
    machineC.parentRelation = "ROOT";
    expect(analyzeLockedUph(multipleRoots)).toMatchObject({ ok: false });

    const nonLeafSample = nestedFixture();
    nonLeafSample.leaves.push({ ...nonLeafSample.leaves[0]!, topologyNodeId: "machine-a" });
    expect(analyzeLockedUph(nonLeafSample)).toMatchObject({ ok: false });

    const insufficientSamples = nestedFixture();
    insufficientSamples.leaves[0]!.includedSampleCount = "9";
    expect(analyzeLockedUph(insufficientSamples)).toMatchObject({ ok: false });

    const unsupportedFormula = nestedFixture();
    unsupportedFormula.formulaCode = "CANONICAL_UPH_V2";
    expect(analyzeLockedUph(unsupportedFormula)).toMatchObject({
      ok: false,
      issues: [{ code: "ANALYSIS_FORMULA_UNSUPPORTED" }]
    });
  });

  it("rejects numeric(20,6) overflow and positive values that would round to zero before persistence", () => {
    const overflow = nestedFixture();
    overflow.leaves[0]!.p90Seconds = "0.000001";
    overflow.leaves[0]!.intrinsicCtSeconds = "0.000001";
    overflow.leaves[0]!.outputPerCycleTotal = "2147483647";
    overflow.leaves[0]!.parallelChannelCount = "2147483647";
    expect(analyzeLockedUph(overflow)).toMatchObject({ ok: false });

    const roundsToZero = nestedFixture();
    roundsToZero.leaves[0]!.p90Seconds = "99999999999999.999999";
    roundsToZero.leaves[0]!.intrinsicCtSeconds = "99999999999999.999999";
    expect(analyzeLockedUph(roundsToZero)).toMatchObject({ ok: false });
  });
});
