import { z } from "zod";

import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  identifierSchema,
  nonNegativeVersionSchema,
  positiveVersionSchema,
  reasonSchema
} from "@/modules/platform-api/contracts/dto";

import { AcceptanceServiceError } from "../application/acceptance-service";
import {
  AcceptancePolicyError,
  ACCEPTANCE_DECISIONS,
  ACCEPTANCE_SCOPE_TYPES,
  ACCEPTANCE_TYPES
} from "../domain/acceptance-policy";

const acceptanceTypeSchema = z.enum(ACCEPTANCE_TYPES);
const scopeTypeSchema = z.enum(ACCEPTANCE_SCOPE_TYPES);
const decisionSchema = z.enum(ACCEPTANCE_DECISIONS);

const acceptanceTemplateItemSchema = z.strictObject({
  code: z.string().trim().min(1).max(191),
  name: z.string().trim().min(1).max(512),
  position: z.number().int().min(1),
  method: z.string().trim().min(1).max(4096),
  acceptanceCriteria: z.string().trim().min(1).max(4096),
  unit: z.string().trim().max(64).nullable(),
  required: z.boolean(),
  evidenceRequired: z.boolean(),
  applicableScope: z.string().trim().min(1).max(191),
  defaultDiscipline: z.string().trim().min(1).max(191)
});

export const acceptanceBatchPathSchema = z.strictObject({
  projectId: identifierSchema,
  batchId: identifierSchema
});

export const acceptanceResultPathSchema = z.strictObject({
  projectId: identifierSchema,
  batchId: identifierSchema,
  itemId: identifierSchema
});

export const acceptanceSummaryPathSchema = acceptanceBatchPathSchema;

export const acceptanceBatchQuerySchema = z.strictObject({
  acceptanceType: acceptanceTypeSchema.optional(),
  cursor: identifierSchema.optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/u)
    .optional()
    .transform((value) => (value === undefined ? 50 : Number(value)))
    .pipe(z.number().int().min(1).max(100))
});

export const acceptanceTemplateQuerySchema = z.strictObject({
  acceptanceType: acceptanceTypeSchema.optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/u)
    .optional()
    .transform((value) => (value === undefined ? 50 : Number(value)))
    .pipe(z.number().int().min(1).max(100))
});

export const createAcceptanceBatchBodySchema = z.strictObject({
  acceptanceType: acceptanceTypeSchema,
  scopeType: scopeTypeSchema,
  scopeId: identifierSchema,
  templateVersionId: identifierSchema,
  retestOfBatchId: identifierSchema.nullable().optional(),
  version: nonNegativeVersionSchema
});

export const createAcceptanceTemplateBodySchema = z.strictObject({
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(512),
  acceptanceType: acceptanceTypeSchema,
  items: z.array(acceptanceTemplateItemSchema).min(1).max(1000)
});

export const acceptanceResultBodySchema = z.strictObject({
  version: positiveVersionSchema,
  itemId: identifierSchema,
  decision: decisionSchema,
  measuredValue: z.string().trim().max(2000).nullable().optional(),
  measuredUnit: z.string().trim().max(64).nullable().optional(),
  note: z.string().trim().max(4096).nullable().optional(),
  correctionReason: reasonSchema.max(2048).nullable().optional(),
  evidenceFileIds: z.array(identifierSchema).max(100).optional().default([])
});

export const acceptanceBatchTransitionBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema.optional()
});

export type AcceptanceBatchPath = z.infer<typeof acceptanceBatchPathSchema>;
export type AcceptanceBatchQuery = z.infer<typeof acceptanceBatchQuerySchema>;
export type CreateAcceptanceBatchBody = z.infer<typeof createAcceptanceBatchBodySchema>;
export type CreateAcceptanceTemplateBody = z.infer<typeof createAcceptanceTemplateBodySchema>;
export type AcceptanceResultBody = z.infer<typeof acceptanceResultBodySchema>;

export function acceptanceServiceErrorResponse(error: unknown): Response | null {
  if (error instanceof AcceptanceServiceError || error instanceof AcceptancePolicyError) {
    return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
  }
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string" &&
    typeof (error as { status?: unknown }).status === "number"
  ) {
    const failure = error as { code: string; message: string; status: number };
    return apiErrorResponse({
      status: failure.status,
      code: failure.code,
      message: failure.message
    });
  }
  return null;
}
