import { Prisma } from "@prisma/client";
import { z } from "zod";

import {
  identifierSchema,
  positiveVersionSchema,
  reasonSchema
} from "@/modules/platform-api/contracts/dto";
import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";

import { AssetUpgradeImpactError } from "../domain/asset-upgrade-impact";
import {
  projectAssetConfigurationSchema,
  projectAssetQuantitySchema,
  projectAssetUsageScopeSchema
} from "./project-asset-usage-http";

const jsonObjectSchema = z
  .record(z.string(), z.json())
  .refine((value) => Object.keys(value).length > 0, "对象不能为空。");
const severitySchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
const pageQuerySchema = z.strictObject({
  cursor: identifierSchema.optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/u)
    .optional()
    .transform((value) => (value === undefined ? 50 : Number(value)))
    .pipe(z.number().int().min(1).max(100))
});

export const assetReleaseRecallCollectionPathSchema = z.strictObject({
  technicalAssetId: identifierSchema,
  releaseId: identifierSchema
});
export const assetReleaseRecallRevisionPathSchema = z.strictObject({
  technicalAssetId: identifierSchema,
  recallId: identifierSchema
});
export const assetUpgradeCandidateCollectionPathSchema = z.strictObject({
  technicalAssetId: identifierSchema
});
export const assetReleaseRecallQuerySchema = pageQuerySchema;
export const assetUpgradeCandidateQuerySchema = pageQuerySchema;

export const assetReleaseRecallCreateBodySchema = z
  .strictObject({
    releaseResourceVersion: positiveVersionSchema,
    scope: z.enum(["RELEASE", "RELEASE_VERSION"]),
    targetReleaseVersionId: identifierSchema.nullable().optional(),
    sourceAssetReleaseVersionId: identifierSchema,
    severity: severitySchema,
    reason: reasonSchema,
    evidence: jsonObjectSchema
  })
  .superRefine((value, context) => {
    const targetReleaseVersionId = value.targetReleaseVersionId ?? null;
    if (
      (value.scope === "RELEASE" && targetReleaseVersionId !== null) ||
      (value.scope === "RELEASE_VERSION" && targetReleaseVersionId === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["targetReleaseVersionId"],
        message: "targetReleaseVersionId 必须与召回 scope 一致。"
      });
    }
  });

export const assetReleaseRecallRevisionBodySchema = z.strictObject({
  version: positiveVersionSchema,
  kind: z.enum(["CORRECTED", "WITHDRAWN", "REISSUED"]),
  sourceAssetReleaseVersionId: identifierSchema,
  severity: severitySchema,
  reason: reasonSchema,
  evidence: jsonObjectSchema
});

export const assetUpgradeCandidateCreateBodySchema = z
  .strictObject({
    assetVersion: positiveVersionSchema,
    sourceAssetReleaseVersionId: identifierSchema,
    targetAssetReleaseVersionId: identifierSchema,
    compatibility: z.strictObject({
      level: z.enum(["FULL", "CONDITIONAL", "INCOMPATIBLE"]),
      summary: z.string().trim().min(1).max(2000),
      constraints: z.array(z.string().trim().min(1).max(1000)).max(100),
      evidence: jsonObjectSchema
    }),
    reason: reasonSchema
  })
  .refine((value) => value.sourceAssetReleaseVersionId !== value.targetAssetReleaseVersionId, {
    path: ["targetAssetReleaseVersionId"],
    message: "target ReleaseVersion 必须与 source 不同。"
  });

const adoptionMappingSchema = z
  .strictObject({
    sourceUsageId: identifierSchema,
    sourceUsageVersion: positiveVersionSchema,
    targetUsageKey: identifierSchema,
    targetComponentSnapshotId: identifierSchema,
    migrationMode: z.enum(["COPY", "OVERRIDE"]),
    quantity: projectAssetQuantitySchema.optional(),
    configuration: projectAssetConfigurationSchema.optional(),
    scopeType: projectAssetUsageScopeSchema.optional(),
    scopeId: identifierSchema.optional(),
    deliveryUnitId: identifierSchema.nullable().optional(),
    moduleId: identifierSchema.nullable().optional()
  })
  .superRefine((value, context) => {
    const overrideFields = [
      value.quantity,
      value.configuration,
      value.scopeType,
      value.scopeId,
      value.deliveryUnitId,
      value.moduleId
    ];
    if (value.migrationMode === "COPY" && overrideFields.some((field) => field !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["migrationMode"],
        message: "COPY 不得提交 OVERRIDE 字段。"
      });
    }
    if (
      value.migrationMode === "OVERRIDE" &&
      overrideFields.slice(0, 4).some((field) => field === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["migrationMode"],
        message: "OVERRIDE 必须完整提交 quantity/configuration/scope。"
      });
    }
  });

export const projectAssetUpgradeAdoptionBodySchema = z.strictObject({
  candidateId: identifierSchema,
  impactId: identifierSchema,
  impactVersion: positiveVersionSchema,
  sourceReferenceId: identifierSchema,
  sourceReferenceVersion: positiveVersionSchema,
  reason: reasonSchema,
  mappings: z.array(adoptionMappingSchema).max(1000)
});

export function assetUpgradeImpactErrorResponse(error: unknown): Response | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002")
      return apiErrorResponse({
        status: 409,
        code: "ASSET_UPGRADE_IMPACT_DUPLICATE",
        message: "资产召回或升级候选事实已存在。"
      });
    if (error.code === "P2003" || error.code === "P2004")
      return apiErrorResponse({
        status: 409,
        code: "ASSET_UPGRADE_IMPACT_RELATION_CONFLICT",
        message: "资产召回或升级候选关系及状态不允许该操作。"
      });
    if (error.code === "P2025")
      return apiErrorResponse({
        status: 404,
        code: "ASSET_UPGRADE_IMPACT_NOT_FOUND",
        message: "资产召回或升级候选事实不存在。"
      });
  }
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
  }
  if (!(error instanceof AssetUpgradeImpactError)) return null;
  const conflict = new Set([
    "RECALL_REVISION_INVALID",
    "RECALL_REVISION_SOURCE_MISMATCH",
    "RECALL_AFFECTED_VERSION_SET_CHANGED"
  ]).has(error.code);
  return apiErrorResponse({
    status: conflict ? 409 : 422,
    code: error.code,
    message: error.message
  });
}
