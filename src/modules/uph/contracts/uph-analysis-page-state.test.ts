import { describe, expect, it } from "vitest";

import { displayValue, statusLabel, toAnalysisView } from "./uph-analysis-page-state";

const snapshot = {
  analysisId: "analysis-1",
  projectId: "project-1",
  batchId: "batch-1",
  revisionId: "revision-1",
  lockedChecksum: "a".repeat(64),
  formulaVersionId: "formula-1",
  formulaChecksum: "b".repeat(64),
  engineCode: "UPH_ANALYSIS@1",
  status: "COMPUTED",
  warnings: ["A_GT_ONE"],
  rootMeasuredCapacityUph: "120.000000",
  actualGoodUph: "90.000000",
  a: "0.900000",
  resourceVersion: 1,
  createdById: "user-1",
  createdAt: "2026-08-31T10:00:00.000Z",
  inputSnapshot: { bindings: [{ validSampleCount: "10", p90Seconds: "30.000000" }] },
  resultSnapshot: {
    moduleFpy: [{ moduleId: "module-1", fpy: "0.900000" }],
    bottleneck: [
      {
        sourceType: "PROJECT_MODULE",
        sourceId: "module-1",
        relation: "LEAF",
        capacityUph: "120.000000",
        members: []
      }
    ],
    secondBottleneck: null,
    reductionLevels: []
  }
};

describe("UPH analysis page state", () => {
  it("keeps API metrics and reduction facts display-only", () => {
    const view = toAnalysisView(snapshot);
    expect(view.actualGoodUph).toBe("90.000000");
    expect(view.moduleFpy).toEqual([{ moduleId: "module-1", fpy: "0.900000" }]);
    expect(view.bottleneck[0]?.sourceId).toBe("module-1");
    expect(view.statistics.validSampleCount).toBe("10");
    expect(view.statistics.p50Seconds).toBeNull();
  });

  it("turns unknown or corrupt snapshots into 无数据 rather than inferred values", () => {
    const view = toAnalysisView({
      ...snapshot,
      resultSnapshot: { moduleFpy: "bad", bottleneck: [{ nope: true }] },
      inputSnapshot: null,
      warnings: "bad"
    });
    expect(view.rootMeasuredCapacityUph).toBe("120.000000");
    expect(view.moduleFpy).toEqual([]);
    expect(view.bottleneck).toEqual([]);
    expect(view.statistics.p90Seconds).toBeNull();
    expect(displayValue(null)).toBe("无数据");
  });

  it("labels read-only historical states", () => {
    expect(statusLabel("SUPERSEDED")).toBe("已被后续版本替代");
    expect(statusLabel("UNKNOWN")).toBe("UNKNOWN");
  });
});
