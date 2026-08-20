import { z } from "zod";

import {
  identifierSchema,
  nonNegativeVersionSchema,
  positiveVersionSchema,
  reasonSchema
} from "@/modules/platform-api/contracts/dto";

const contributionSchema = z.strictObject({
  scopeType: z.enum(["PROJECT", "DELIVERY_UNIT"]),
  deliveryUnitId: identifierSchema.nullable(),
  discipline: z.string().trim().min(1).max(191),
  contributorMembershipId: identifierSchema,
  factText: z.string().trim().min(1).max(4096),
  impactText: z.string().trim().min(1).max(4096),
  reusable: z.boolean(),
  required: z.boolean()
});

export const retrospectivePathSchema = z.strictObject({ projectId: identifierSchema });
export const retrospectiveVersionPathSchema = z.strictObject({
  projectId: identifierSchema,
  versionId: identifierSchema
});

export const createRetrospectiveBodySchema = z.strictObject({
  archiveVersionId: identifierSchema,
  expectedAggregateVersion: nonNegativeVersionSchema.nullable(),
  content: z.strictObject({
    deliverySummary: z.unknown(),
    successfulPractices: z.unknown(),
    shortcomings: z.unknown(),
    improvements: z.unknown(),
    knowledgeDisposition: z.unknown(),
    ipDeclaration: z.unknown()
  }),
  contributions: z.array(contributionSchema).max(100),
  participantMembershipIds: z.array(identifierSchema).max(100),
  issueHistoryIds: z.array(identifierSchema).max(500)
});

export const submitRetrospectiveBodySchema = z.strictObject({
  expectedAggregateVersion: positiveVersionSchema
});

export const reviewRetrospectiveBodySchema = z.strictObject({
  expectedAggregateVersion: positiveVersionSchema,
  decision: z.enum(["APPROVED", "REJECTED"]),
  reason: reasonSchema.max(2048)
});

export type CreateRetrospectiveBody = z.infer<typeof createRetrospectiveBodySchema>;
export type SubmitRetrospectiveBody = z.infer<typeof submitRetrospectiveBodySchema>;
export type ReviewRetrospectiveBody = z.infer<typeof reviewRetrospectiveBodySchema>;
