import { z } from "zod";

const identifier = z.string().trim().min(1).max(191);
const text = (maximum: number) => z.string().trim().min(1).max(maximum);

export const uphPerformanceIssuePathSchema = z.strictObject({
  projectId: identifier,
  batchId: identifier,
  revisionId: identifier,
  analysisId: identifier
});

export const createUphPerformanceIssueBodySchema = z.strictObject({
  title: text(191),
  confirmedText: text(10_000),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  reason: text(1_024)
});

export type UphPerformanceIssuePath = z.infer<typeof uphPerformanceIssuePathSchema>;
export type CreateUphPerformanceIssueBody = z.infer<typeof createUphPerformanceIssueBodySchema>;

// Explicit aliases keep the route contract discoverable alongside the analysis contracts.
export const performanceIssuePathSchema = uphPerformanceIssuePathSchema;
export const performanceIssueBodySchema = createUphPerformanceIssueBodySchema;
