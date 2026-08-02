import { z } from "zod";

import { PROJECT_ROLE_VALUES } from "@/lib/auth/permissions";

import {
  identifierSchema,
  nonNegativeVersionSchema,
  positiveVersionSchema,
  reasonSchema
} from "./dto";

export const settingPathSchema = z.strictObject({ key: identifierSchema });
export const settingBodySchema = z.strictObject({
  value: z.number().int(),
  version: positiveVersionSchema,
  reason: reasonSchema
});

export const capabilityPathSchema = z.strictObject({ code: identifierSchema });
export const capabilityBodySchema = z.strictObject({
  enabled: z.boolean(),
  version: positiveVersionSchema,
  reason: reasonSchema
});

export const jobPathSchema = z.strictObject({ jobId: identifierSchema });
export const replayJobBodySchema = z.strictObject({ reason: reasonSchema });

export const projectPathSchema = z.strictObject({ projectId: identifierSchema });
export const projectMembershipPathSchema = z.strictObject({
  projectId: identifierSchema,
  membershipId: identifierSchema
});
export const addProjectMemberBodySchema = z.strictObject({
  userId: identifierSchema,
  projectRole: z.enum(PROJECT_ROLE_VALUES),
  departmentId: identifierSchema.nullable().optional(),
  projectVersion: positiveVersionSchema
});
export const membershipCommandHeadersSchema = z.strictObject({
  idempotencyKey: identifierSchema,
  ifMatch: z.string().trim().min(1).max(32)
});

const variableNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
const variableDefinitionSchema = z.strictObject({
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean().optional()
});
export const notificationTemplatePathSchema = z.strictObject({ code: identifierSchema });
export const publishNotificationTemplateBodySchema = z.strictObject({
  version: nonNegativeVersionSchema,
  subjectTemplate: z.string().trim().min(1).max(998),
  bodyTextTemplate: z.string().trim().min(1).max(100_000),
  bodyHtmlTemplate: z.string().trim().min(1).max(200_000).nullable().optional(),
  variableSchema: z.record(variableNameSchema, variableDefinitionSchema)
});
export const notificationTemplateStatusBodySchema = z.strictObject({
  version: positiveVersionSchema,
  enabled: z.boolean(),
  reason: reasonSchema
});

export const notificationPathSchema = z.strictObject({ notificationId: identifierSchema });
export const notificationQuerySchema = z.strictObject({
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  cursor: identifierSchema.optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/u)
    .optional()
    .transform((value) => (value === undefined ? 50 : Number(value)))
    .pipe(z.number().int().min(1).max(100))
});

export const startFileUploadBodySchema = z.strictObject({
  originalName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => !/[\u0000-\u001f/\\]/u.test(value)),
  mimeType: z
    .string()
    .trim()
    .toLowerCase()
    .max(191)
    .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sensitivity: z.enum(["INTERNAL", "RESTRICTED"]).optional()
});

export const uploadSessionPathSchema = z.strictObject({
  projectId: identifierSchema,
  sessionId: identifierSchema
});
export const uploadPartPathSchema = z.strictObject({
  projectId: identifierSchema,
  sessionId: identifierSchema,
  partNumber: z
    .string()
    .regex(/^\d{1,5}$/u)
    .transform(Number)
    .pipe(z.number().int().min(1).max(10_000))
});
const completionPartSchema = z.strictObject({
  partNumber: z.number().int().min(1).max(10_000),
  etag: z.string().trim().min(1).max(1024),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
});
export const completeFileUploadBodySchema = z.strictObject({
  mimeType: z
    .string()
    .trim()
    .toLowerCase()
    .max(191)
    .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  parts: z.array(completionPartSchema).min(1).max(10_000)
});
