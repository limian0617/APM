import { describe, expect, it } from "vitest";

import {
  createUphPerformanceIssueBodySchema,
  uphPerformanceIssuePathSchema
} from "./uph-performance-issue-http";

describe("APM-084 performance issue HTTP contract", () => {
  it("accepts only the server-owned issue creation fields", () => {
    expect(
      createUphPerformanceIssueBodySchema.parse({
        title: "UPH below target",
        confirmedText: "Actual good UPH is below the configured target.",
        severity: "MEDIUM",
        reason: "Record the locked analysis shortfall"
      })
    ).toMatchObject({ severity: "MEDIUM" });
    expect(() =>
      createUphPerformanceIssueBodySchema.parse({
        title: "x",
        confirmedText: "x",
        severity: "LOW",
        reason: "x",
        category: "SAFETY"
      })
    ).toThrow();
  });

  it("requires all four path identities", () => {
    expect(
      uphPerformanceIssuePathSchema.parse({
        projectId: "p1",
        batchId: "b1",
        revisionId: "r1",
        analysisId: "a1"
      })
    ).toEqual({ projectId: "p1", batchId: "b1", revisionId: "r1", analysisId: "a1" });
  });
});
