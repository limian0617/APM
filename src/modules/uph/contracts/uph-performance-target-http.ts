import { z } from "zod";

const identifier = z.string().trim().min(1).max(191);
const targetUph = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,19})(?:\.\d{1,6})?$/u)
  .refine((value) => !/^0+(?:\.0+)?$/u.test(value));
const reason = z.string().trim().min(1).max(1024);

export const uphTargetPathSchema = z.strictObject({ projectId: identifier });
export const uphTargetVersionPathSchema = z.strictObject({
  projectId: identifier,
  targetVersionId: identifier
});
export const createUphPerformanceTargetBodySchema = z.strictObject({
  topologyRootNodeId: identifier,
  targetUph,
  reason
});
export const publishUphPerformanceTargetBodySchema = z.strictObject({
  resourceVersion: z.number().int().min(1),
  reason
});
export const listUphPerformanceTargetsQuerySchema = z.strictObject({
  topologyRootNodeId: identifier.optional(),
  revisionId: identifier.optional()
});

export type CreateUphPerformanceTargetBody = z.infer<typeof createUphPerformanceTargetBodySchema>;
export type PublishUphPerformanceTargetBody = z.infer<typeof publishUphPerformanceTargetBodySchema>;
