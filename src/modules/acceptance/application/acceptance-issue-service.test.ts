import { describe, expect, it } from "vitest";

import { buildAcceptanceFailureSourceSnapshot } from "./acceptance-issue-service";

describe("APM-101 acceptance issue application boundary", () => {
  it("freezes the exact failed revision, batch scope, template checksum and measured fact", () => {
    expect(
      buildAcceptanceFailureSourceSnapshot({
        acceptanceType: "FAT",
        batchId: "batch-1",
        scopeType: "MACHINE",
        scopeId: "machine-1",
        templateVersionId: "template-version-1",
        templateChecksum: "sha256:template",
        resultId: "result-1",
        resultRevisionId: "revision-2",
        revisionNo: 2,
        decision: "FAIL",
        measuredValue: "180V",
        measuredUnit: "V",
        note: "掉压",
        item: {
          id: "item-1",
          code: "POWER",
          name: "上电",
          method: "测量",
          acceptanceCriteria: "220±10V",
          unit: "V"
        }
      })
    ).toEqual({
      acceptanceType: "FAT",
      batchId: "batch-1",
      scopeType: "MACHINE",
      scopeId: "machine-1",
      templateVersionId: "template-version-1",
      templateChecksum: "sha256:template",
      resultId: "result-1",
      resultRevisionId: "revision-2",
      revisionNo: 2,
      decision: "FAIL",
      measuredValue: "180V",
      measuredUnit: "V",
      note: "掉压",
      testItem: {
        id: "item-1",
        code: "POWER",
        name: "上电",
        method: "测量",
        acceptanceCriteria: "220±10V",
        unit: "V"
      }
    });
  });
});
