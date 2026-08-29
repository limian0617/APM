import { describe, expect, it } from "vitest";

import {
  projectAssetImpactCollectionPathSchema,
  projectAssetImpactCommandBodySchema,
  projectAssetImpactPathSchema,
  projectAssetImpactQuerySchema,
  projectAssetImpactRiskAcceptancePathSchema
} from "./project-asset-impact-http";

describe("APM-064 project asset impact HTTP contract", () => {
  it("accepts only exact project and impact path identities", () => {
    expect(
      projectAssetImpactPathSchema.parse({ projectId: "project-1", impactId: "impact-1" })
    ).toEqual({ projectId: "project-1", impactId: "impact-1" });
    expect(
      projectAssetImpactRiskAcceptancePathSchema.parse({
        projectId: "project-1",
        impactId: "impact-1",
        requestId: "request-1"
      })
    ).toEqual({ projectId: "project-1", impactId: "impact-1", requestId: "request-1" });
    expect(() =>
      projectAssetImpactCollectionPathSchema.parse({
        projectId: "project-1",
        technicalAssetId: "asset-1"
      })
    ).toThrowError();
  });

  it("uses bounded cursor pagination and rejects undeclared filters", () => {
    expect(projectAssetImpactQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(projectAssetImpactQuerySchema.parse({ cursor: "impact-1", limit: "100" })).toEqual({
      cursor: "impact-1",
      limit: 100
    });
    expect(() => projectAssetImpactQuerySchema.parse({ limit: "101" })).toThrowError();
    expect(() => projectAssetImpactQuerySchema.parse({ status: "OPEN" })).toThrowError();
  });

  it("requires version, reason and a non-empty JSON evidence object without extra fields", () => {
    expect(
      projectAssetImpactCommandBodySchema.parse({
        version: 2,
        reason: "review impact",
        evidence: { report: "report-1", checks: ["exact-version"] }
      })
    ).toMatchObject({ version: 2, reason: "review impact" });
    expect(() =>
      projectAssetImpactCommandBodySchema.parse({
        version: 2,
        reason: "review impact",
        evidence: []
      })
    ).toThrowError();
    expect(() =>
      projectAssetImpactCommandBodySchema.parse({
        version: 2,
        reason: "review impact",
        evidence: { report: "report-1" },
        status: "CLOSED"
      })
    ).toThrowError();
  });
});
