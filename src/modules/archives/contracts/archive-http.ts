import { z } from "zod";

import { identifierSchema, positiveVersionSchema } from "@/modules/platform-api/contracts/dto";

export const archiveGenerationBodySchema = z.strictObject({
  version: positiveVersionSchema
});

export type ArchiveGenerationBody = z.infer<typeof archiveGenerationBodySchema>;

export const archiveRecheckBodySchema = z.strictObject({
  version: positiveVersionSchema
});

export const archiveCloseBodySchema = z.strictObject({
  archiveVersionId: identifierSchema,
  g9SubmissionId: identifierSchema,
  version: positiveVersionSchema
});

export const archiveVersionPathSchema = z.strictObject({
  projectId: identifierSchema,
  archiveVersionId: identifierSchema
});

export type ArchiveRecheckBody = z.infer<typeof archiveRecheckBodySchema>;
export type ArchiveCloseBody = z.infer<typeof archiveCloseBodySchema>;
