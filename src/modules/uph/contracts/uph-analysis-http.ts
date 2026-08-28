import { z } from "zod";

const identifier = z.string().trim().min(1).max(191);

/** POST accepts no client-derived calculation, source, identity or scope facts. */
export const createUphAnalysisBodySchema = z.strictObject({});

export const listUphAnalysesQuerySchema = z.strictObject({
  cursor: identifier.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

export const uphAnalysisCollectionPathSchema = z.strictObject({
  projectId: identifier,
  batchId: identifier,
  revisionId: identifier
});

/** Detail identity is part of the route path, never a collection query selector. */
export const uphAnalysisDetailPathSchema = z.strictObject({
  projectId: identifier,
  batchId: identifier,
  revisionId: identifier,
  analysisId: identifier
});

export type CreateUphAnalysisBody = z.infer<typeof createUphAnalysisBodySchema>;
export type ListUphAnalysesQuery = z.infer<typeof listUphAnalysesQuerySchema>;
export type UphAnalysisCollectionPath = z.infer<typeof uphAnalysisCollectionPathSchema>;
export type UphAnalysisDetailPath = z.infer<typeof uphAnalysisDetailPathSchema>;
