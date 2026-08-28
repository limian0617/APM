import { z } from "zod";
import { Prisma } from "@prisma/client";

import {
  parseDto,
  identifierSchema,
  positiveVersionSchema,
  reasonSchema
} from "@/modules/platform-api/contracts/dto";
import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";

const checksumSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{64}$/iu)
  .transform((value) => value.toLowerCase());
export const projectAssetQuantitySchema = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d{0,19})(?:\.\d{1,6})?$/u);
export const projectAssetConfigurationSchema = z.strictObject({
  purpose: z.string().trim().min(1).max(200),
  parameters: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().trim().max(2000).optional()
});

export const projectAssetUsageScopeSchema = z.enum(["PROJECT", "DELIVERY_UNIT", "MODULE"]);

export const projectAssetUsageCreateBodySchema = z
  .strictObject({
    usageKey: identifierSchema,
    referenceVersion: positiveVersionSchema,
    componentSnapshotId: identifierSchema,
    quantity: projectAssetQuantitySchema,
    configuration: projectAssetConfigurationSchema,
    scopeType: projectAssetUsageScopeSchema,
    scopeId: identifierSchema,
    deliveryUnitId: identifierSchema.nullable().optional(),
    moduleId: identifierSchema.nullable().optional(),
    reason: reasonSchema
  })
  .superRefine((value, context) => {
    const deliveryUnitId = value.deliveryUnitId ?? null;
    const moduleId = value.moduleId ?? null;
    const valid =
      (value.scopeType === "PROJECT" && !deliveryUnitId && !moduleId) ||
      (value.scopeType === "DELIVERY_UNIT" && value.scopeId === deliveryUnitId && !moduleId) ||
      (value.scopeType === "MODULE" && value.scopeId === moduleId && Boolean(deliveryUnitId));
    if (!valid)
      context.addIssue({
        code: "custom",
        message: "scope 与项目层级不一致。",
        path: ["scopeType"]
      });
  });

export const projectAssetRetireBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema
});

export const projectAssetDerivationTargetTypeSchema = z.enum([
  "CONTROLLED_DOCUMENT_VERSION",
  "MECHANICAL_DRAWING_VERSION"
]);

export const projectAssetDerivationCreateBodySchema = z.strictObject({
  usageVersion: positiveVersionSchema,
  targetType: projectAssetDerivationTargetTypeSchema,
  targetControlledDocumentVersionId: identifierSchema,
  targetMechanicalDrawingId: identifierSchema.nullable().optional(),
  targetSourceFileSha256: checksumSchema,
  targetSourceFileId: identifierSchema,
  targetDocumentVersion: positiveVersionSchema,
  targetDocumentVersionStatus: z.enum(["DRAFT", "PUBLISHED", "SUPERSEDED"]),
  targetFileStatus: z.enum(["UPLOADING", "PENDING_SCAN", "AVAILABLE", "QUARANTINED", "FAILED"]),
  reason: reasonSchema
});

export function parseProjectAssetUsageCreateBody(value: unknown) {
  return parseDto(projectAssetUsageCreateBodySchema, value, "body");
}

export function projectAssetUsageErrorResponse(error: unknown): Response | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002")
      return apiErrorResponse({
        status: 409,
        code: "PROJECT_ASSET_DUPLICATE",
        message: "项目资产事实已存在或与并发请求冲突。"
      });
    if (error.code === "P2003")
      return apiErrorResponse({
        status: 409,
        code: "PROJECT_ASSET_RELATION_CONFLICT",
        message: "项目资产关系或状态不允许该操作。"
      });
    if (error.code === "P2004")
      return apiErrorResponse({
        status: 409,
        code: "PROJECT_ASSET_RELATION_CONFLICT",
        message: "项目资产关系或状态不允许该操作。"
      });
    if (error.code === "P2025")
      return apiErrorResponse({
        status: 404,
        code: "PROJECT_ASSET_NOT_FOUND",
        message: "项目资产事实不存在。"
      });
  }
  if (!(error instanceof Error) || !("code" in error) || !("status" in error)) return null;
  const value = error as Error & { code: string; status: number };
  return apiErrorResponse({ status: value.status, code: value.code, message: value.message });
}
