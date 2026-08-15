import { z } from "zod";

import { KnowledgeAuthorizationQueryError } from "@/modules/knowledge/application/knowledge-authorization-query";
import { KnowledgeEntryServiceError } from "@/modules/knowledge/application/knowledge-entry-service";
import { KnowledgeReuseServiceError } from "@/modules/knowledge/application/knowledge-reuse-service";
import { KnowledgeSearchCapabilityError } from "@/modules/knowledge/application/knowledge-search-capability";
import { KnowledgeSearchServiceError } from "@/modules/knowledge/application/knowledge-search-service";
import {
  ApiContractError,
  apiContractErrorResponse,
  apiErrorResponse
} from "@/modules/platform-api/contracts/errors";

const identifierSchema = z.string().trim().min(1).max(191);
const positiveVersionSchema = z.number().int().min(1).max(2_147_483_647);
const commandReasonSchema = z.string().trim().min(1).max(4_096);
const controlledTextSchema = z.string().trim().min(1).max(16_384);
const controlledCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9._-]{1,63}$/u);
const distinctIdentifiersSchema = z
  .array(identifierSchema)
  .max(500)
  .refine((values) => new Set(values).size === values.length, {
    message: "标识不得重复。"
  });

const knowledgeDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(256),
  sanitizedSummary: z.string().trim().min(1).max(4_096),
  experienceType: controlledCodeSchema,
  discipline: controlledCodeSchema,
  keywords: z
    .array(z.string().trim().min(1).max(128))
    .min(1)
    .max(50)
    .refine(
      (values) => new Set(values.map((value) => value.toUpperCase())).size === values.length,
      {
        message: "keywords 不得重复。"
      }
    ),
  applicableProjectTypes: z
    .array(controlledCodeSchema)
    .max(50)
    .refine((values) => new Set(values).size === values.length, {
      message: "applicableProjectTypes 不得重复。"
    }),
  applicableStageCodes: z
    .array(controlledCodeSchema)
    .max(50)
    .refine((values) => new Set(values).size === values.length, {
      message: "applicableStageCodes 不得重复。"
    }),
  preconditions: controlledTextSchema,
  recommendedPractice: controlledTextSchema,
  antiPatterns: controlledTextSchema,
  limitations: controlledTextSchema,
  ipSanitizationDeclaration: controlledTextSchema,
  internalReusable: z.boolean()
});

const knowledgeSourceBodyShape = {
  code: controlledCodeSchema,
  sourceProjectId: identifierSchema,
  finalArchiveVersionId: identifierSchema,
  retrospectiveInputArchiveVersionId: identifierSchema,
  retrospectiveVersionId: identifierSchema,
  issueHistoryIds: distinctIdentifiersSchema,
  draft: knowledgeDraftSchema
};

export const createKnowledgeEntryBodySchema = z.strictObject({
  ...knowledgeSourceBodyShape,
  expectedEntryVersion: z.null()
});

export const createKnowledgeEntryVersionBodySchema = z.strictObject({
  ...knowledgeSourceBodyShape,
  expectedEntryVersion: positiveVersionSchema
});

export const knowledgeSearchQuerySchema = z
  .strictObject({
    query: z.string().trim().min(1).max(64),
    page: z
      .string()
      .regex(/^\d{1,4}$/u)
      .optional()
      .transform((value) => (value === undefined ? 1 : Number(value)))
      .pipe(z.number().int().min(1).max(10_000)),
    pageSize: z
      .string()
      .regex(/^\d{1,3}$/u)
      .optional()
      .transform((value) => (value === undefined ? 20 : Number(value)))
      .pipe(z.number().int().min(1).max(20)),
    experienceType: controlledCodeSchema.optional(),
    discipline: controlledCodeSchema.optional(),
    applicableProjectType: controlledCodeSchema.optional(),
    applicableStageCode: controlledCodeSchema.optional(),
    targetProjectId: identifierSchema.optional(),
    reuseId: identifierSchema.optional()
  })
  .superRefine((value, context) => {
    if (value.reuseId && !value.targetProjectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reuseId"],
        message: "reuseId 必须与目标项目上下文一起提供。"
      });
    }
  });

export const knowledgePageStateQuerySchema = z
  .strictObject({
    view: z.literal("PAGE_STATE"),
    targetProjectId: identifierSchema.optional(),
    reuseId: identifierSchema.optional()
  })
  .superRefine((value, context) => {
    if (value.reuseId && !value.targetProjectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reuseId"],
        message: "reuseId 必须与目标项目上下文一起提供。"
      });
    }
  });

export const knowledgeSubmitBodySchema = z.strictObject({
  expectedEntryVersion: positiveVersionSchema
});

export const knowledgeReviewBodySchema = z.strictObject({
  expectedEntryVersion: positiveVersionSchema,
  decision: z.enum(["PUBLISH", "REJECT"]),
  reason: commandReasonSchema,
  ipConfirmed: z.boolean(),
  sanitizationConfirmed: z.boolean()
});

export const knowledgeRevokeBodySchema = z.strictObject({
  versionId: identifierSchema,
  expectedEntryVersion: positiveVersionSchema,
  reason: commandReasonSchema
});

export const knowledgeReuseBodySchema = z.strictObject({
  targetDeliveryUnitId: identifierSchema.nullable(),
  entryCode: controlledCodeSchema,
  version: positiveVersionSchema,
  scenario: z.string().trim().min(1).max(4_096),
  evidenceSummary: z.string().trim().min(1).max(4_096)
});

export const knowledgeCorrectionBodySchema = z.strictObject({
  expectedReuseVersion: positiveVersionSchema,
  correctionType: z.enum(["TEXT_CORRECTION", "USAGE_WITHDRAWN", "SCOPE_CORRECTION"]),
  reason: commandReasonSchema,
  correctionText: z.string().trim().min(1).max(4_096)
});

export const knowledgeEntryPathSchema = z.strictObject({ entryId: identifierSchema });
export const knowledgeVersionPathSchema = z.strictObject({
  entryId: identifierSchema,
  versionId: identifierSchema
});
export const projectKnowledgeReusePathSchema = z.strictObject({ projectId: identifierSchema });
export const projectKnowledgeReuseCorrectionPathSchema = z.strictObject({
  projectId: identifierSchema,
  reuseId: identifierSchema
});

export type PublicKnowledgeVersionDto = {
  entryCode: string;
  version: number;
  title: string;
  sanitizedSummary: string;
  experienceType: string;
  discipline: string;
  keywords: string[];
  applicableProjectTypes: string[];
  applicableStageCodes: string[];
  status: "PUBLISHED" | "SUPERSEDED" | "REVOKED";
};

export function knowledgeServiceErrorResponse(error: unknown): Response | null {
  if (!(
    error instanceof KnowledgeAuthorizationQueryError ||
    error instanceof KnowledgeEntryServiceError ||
    error instanceof KnowledgeReuseServiceError ||
    error instanceof KnowledgeSearchServiceError ||
    error instanceof KnowledgeSearchCapabilityError
  )) {
    return null;
  }
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}

export function knowledgeCommandContractErrorResponse(error: unknown): Response | null {
  if (error instanceof ApiContractError && error.status === 422) {
    return apiErrorResponse({
      status: 400,
      code: "INVALID_REQUEST",
      message: "请求参数未通过校验。",
      issues: error.issues
    });
  }
  return apiContractErrorResponse(error);
}
