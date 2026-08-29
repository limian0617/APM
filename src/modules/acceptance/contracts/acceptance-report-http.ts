import { z } from "zod";

import { identifierSchema, positiveVersionSchema } from "@/modules/platform-api/contracts/dto";

import {
  ACCEPTANCE_CONFIRMATION_CHANNELS,
  ACCEPTANCE_CONFIRMATION_DECISIONS
} from "../domain/acceptance-report-policy";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, "必须是 SHA-256 十六进制摘要。");

export const acceptanceReportPathSchema = z.strictObject({
  projectId: identifierSchema,
  reportId: identifierSchema
});

export const generateAcceptanceReportBodySchema = z.strictObject({
  batchId: identifierSchema,
  supersedesReportId: identifierSchema.nullable().optional(),
  version: positiveVersionSchema
});

export const createAcceptanceConfirmationBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reportChecksum: sha256Schema,
  decision: z.enum(ACCEPTANCE_CONFIRMATION_DECISIONS),
  customerOrganization: z.string().trim().min(1).max(512),
  customerRepresentative: z.string().trim().min(1).max(512),
  representativeTitle: z.string().trim().min(1).max(512),
  confirmationChannel: z.enum(ACCEPTANCE_CONFIRMATION_CHANNELS),
  customerConfirmedAt: z.string().datetime({ offset: true }),
  comment: z.string().trim().max(4096),
  evidenceFileIds: z.array(identifierSchema).min(1).max(100),
  supersedesConfirmationId: identifierSchema.nullable().optional()
});

export type AcceptanceReportPath = z.infer<typeof acceptanceReportPathSchema>;
export type GenerateAcceptanceReportBody = z.infer<typeof generateAcceptanceReportBodySchema>;
export type CreateAcceptanceConfirmationBody = z.infer<
  typeof createAcceptanceConfirmationBodySchema
>;
