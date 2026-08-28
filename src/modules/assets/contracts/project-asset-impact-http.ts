import { Prisma } from "@prisma/client";
import { z } from "zod";

import {
  identifierSchema,
  positiveVersionSchema,
  reasonSchema
} from "@/modules/platform-api/contracts/dto";
import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";

const evidenceSchema = z
  .record(z.string(), z.json())
  .refine((value) => Object.keys(value).length > 0, "evidence 不能为空。");

export const projectAssetImpactCollectionPathSchema = z.strictObject({
  projectId: identifierSchema
});

export const projectAssetImpactPathSchema = z.strictObject({
  projectId: identifierSchema,
  impactId: identifierSchema
});

export const projectAssetImpactRiskAcceptancePathSchema = z.strictObject({
  projectId: identifierSchema,
  impactId: identifierSchema,
  requestId: identifierSchema
});

export const projectAssetImpactQuerySchema = z.strictObject({
  cursor: identifierSchema.optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/u)
    .optional()
    .transform((value) => (value === undefined ? 50 : Number(value)))
    .pipe(z.number().int().min(1).max(100))
});

export const projectAssetImpactCommandBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema,
  evidence: evidenceSchema
});

export function projectAssetImpactErrorResponse(error: unknown): Response | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002" || error.code === "P2003" || error.code === "P2004") {
      return apiErrorResponse({
        status: 409,
        code: "ASSET_PROJECT_IMPACT_CONFLICT",
        message: "项目资产影响事实或状态不允许该操作。"
      });
    }
    if (error.code === "P2025") {
      return apiErrorResponse({
        status: 404,
        code: "ASSET_PROJECT_IMPACT_NOT_FOUND",
        message: "项目资产影响不存在或不可访问。"
      });
    }
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
  return null;
}
