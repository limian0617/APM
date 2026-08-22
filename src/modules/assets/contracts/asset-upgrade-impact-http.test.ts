import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";

import { AssetUpgradeImpactError } from "../domain/asset-upgrade-impact";
import {
  assetReleaseRecallCreateBodySchema,
  assetReleaseRecallRevisionBodySchema,
  assetUpgradeCandidateCreateBodySchema,
  assetUpgradeImpactErrorResponse,
  projectAssetUpgradeAdoptionBodySchema
} from "./asset-upgrade-impact-http";

describe("APM-064 asset upgrade impact HTTP contracts", () => {
  it("accepts exact recall and candidate commands with strict declared objects", () => {
    expect(
      parseDto(
        assetReleaseRecallCreateBodySchema,
        {
          releaseResourceVersion: 4,
          scope: "RELEASE_VERSION",
          targetReleaseVersionId: "release-version-1",
          sourceAssetReleaseVersionId: "release-version-1",
          severity: "HIGH",
          reason: "issue exact recall",
          evidence: { reportId: "report-1" }
        },
        "body"
      )
    ).toMatchObject({ scope: "RELEASE_VERSION", releaseResourceVersion: 4 });
    expect(
      parseDto(
        assetReleaseRecallRevisionBodySchema,
        {
          version: 2,
          kind: "WITHDRAWN",
          sourceAssetReleaseVersionId: "release-version-1",
          severity: "MEDIUM",
          reason: "withdraw after correction",
          evidence: { approval: "approval-1" }
        },
        "body"
      )
    ).toMatchObject({ version: 2, kind: "WITHDRAWN" });
    expect(
      parseDto(
        assetUpgradeCandidateCreateBodySchema,
        {
          assetVersion: 7,
          sourceAssetReleaseVersionId: "release-version-1",
          targetAssetReleaseVersionId: "release-version-2",
          compatibility: {
            level: "CONDITIONAL",
            summary: "requires a wiring adapter",
            constraints: ["replace adapter"],
            evidence: { testReportId: "report-2" }
          },
          reason: "record exact upgrade path"
        },
        "body"
      )
    ).toMatchObject({ compatibility: { level: "CONDITIONAL" } });
  });

  it("rejects scope drift, empty evidence, non-JSON values, and undeclared compatibility keys", () => {
    const baseRecall = {
      releaseResourceVersion: 1,
      sourceAssetReleaseVersionId: "release-version-1",
      severity: "HIGH",
      reason: "recall",
      evidence: { report: "report-1" }
    };
    expect(() =>
      parseDto(
        assetReleaseRecallCreateBodySchema,
        { ...baseRecall, scope: "RELEASE", targetReleaseVersionId: "must-not-exist" },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        assetUpgradeCandidateCreateBodySchema,
        {
          assetVersion: 1,
          sourceAssetReleaseVersionId: "release-version-1",
          targetAssetReleaseVersionId: "release-version-1",
          compatibility: {
            level: "FULL",
            summary: "same source and target",
            constraints: [],
            evidence: { report: "report-1" }
          },
          reason: "candidate"
        },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        assetReleaseRecallCreateBodySchema,
        { ...baseRecall, scope: "RELEASE_VERSION" },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        assetReleaseRecallCreateBodySchema,
        { ...baseRecall, scope: "RELEASE", evidence: {} },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        assetReleaseRecallCreateBodySchema,
        { ...baseRecall, scope: "RELEASE", evidence: { score: Number.NaN } },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        assetUpgradeCandidateCreateBodySchema,
        {
          assetVersion: 1,
          sourceAssetReleaseVersionId: "release-version-1",
          targetAssetReleaseVersionId: "release-version-2",
          compatibility: {
            level: "FULL",
            summary: "compatible",
            constraints: [],
            evidence: { report: "report-1" },
            implicitDrift: true
          },
          reason: "candidate"
        },
        "body"
      )
    ).toThrowError(ApiContractError);
  });

  it("requires exact adoption identities and separates COPY from complete OVERRIDE", () => {
    expect(
      parseDto(
        projectAssetUpgradeAdoptionBodySchema,
        {
          candidateId: "candidate-1",
          impactId: "impact-1",
          impactVersion: 4,
          sourceReferenceId: "source-reference-1",
          sourceReferenceVersion: 2,
          reason: "adopt exact upgrade",
          mappings: [
            {
              sourceUsageId: "usage-1",
              sourceUsageVersion: 3,
              targetUsageKey: "target-usage-1",
              targetComponentSnapshotId: "target-component-1",
              migrationMode: "COPY"
            },
            {
              sourceUsageId: "usage-2",
              sourceUsageVersion: 1,
              targetUsageKey: "target-usage-2",
              targetComponentSnapshotId: "target-component-2",
              migrationMode: "OVERRIDE",
              quantity: "2.5",
              configuration: { purpose: "override" },
              scopeType: "PROJECT",
              scopeId: "project-1"
            }
          ]
        },
        "body"
      )
    ).toMatchObject({ mappings: expect.any(Array) });
    expect(() =>
      parseDto(
        projectAssetUpgradeAdoptionBodySchema,
        {
          candidateId: "candidate-1",
          impactId: "impact-1",
          impactVersion: 4,
          sourceReferenceId: "source-reference-1",
          sourceReferenceVersion: 2,
          reason: "invalid copy",
          mappings: [
            {
              sourceUsageId: "usage-1",
              sourceUsageVersion: 3,
              targetUsageKey: "target-usage-1",
              targetComponentSnapshotId: "target-component-1",
              migrationMode: "COPY",
              quantity: "2"
            }
          ]
        },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        projectAssetUpgradeAdoptionBodySchema,
        {
          candidateId: "candidate-1",
          impactId: "impact-1",
          impactVersion: 4,
          sourceReferenceId: "source-reference-1",
          sourceReferenceVersion: 2,
          reason: "incomplete override",
          mappings: [
            {
              sourceUsageId: "usage-1",
              sourceUsageVersion: 3,
              targetUsageKey: "target-usage-1",
              targetComponentSnapshotId: "target-component-1",
              migrationMode: "OVERRIDE",
              quantity: "2"
            }
          ]
        },
        "body"
      )
    ).toThrowError(ApiContractError);
  });

  it("maps stable database and domain errors without leaking database details", async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError("duplicate", {
      code: "P2002",
      clientVersion: "test"
    });
    const duplicateResponse = assetUpgradeImpactErrorResponse(duplicate);
    expect(duplicateResponse).toMatchObject({ status: 409 });
    await expect(duplicateResponse?.json()).resolves.toMatchObject({
      error: { code: "ASSET_UPGRADE_IMPACT_DUPLICATE" }
    });

    const invalid = assetUpgradeImpactErrorResponse(
      new AssetUpgradeImpactError("UPGRADE_CANDIDATE_INVALID", "invalid candidate")
    );
    expect(invalid).toMatchObject({ status: 422 });

    const serviceError = Object.assign(new Error("stale recall"), {
      code: "ASSET_RECALL_VERSION_CONFLICT",
      status: 409
    });
    const serviceResponse = assetUpgradeImpactErrorResponse(serviceError);
    expect(serviceResponse).toMatchObject({ status: 409 });
    await expect(serviceResponse?.json()).resolves.toMatchObject({
      error: { code: "ASSET_RECALL_VERSION_CONFLICT" }
    });
  });
});
