import { z } from "zod";

const identifier = z.string().trim().min(1).max(191);
const reason = z.string().trim().min(1).max(1024);
const timestamp = z.string().datetime({ offset: true });
const timezone = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
      return true;
    } catch {
      return false;
    }
  });

export const uphRetestPathSchema = z.strictObject({
  projectId: identifier,
  issueId: identifier
});

export const createUphRetestBodySchema = z.strictObject({
  issueVersion: z.number().int().min(1),
  batchNumber: identifier,
  plannedProductionSeconds: z.number().int().positive().refine(Number.isSafeInteger),
  planDeclarationReason: reason,
  observationStartedAt: timestamp,
  observationEndedAt: timestamp.nullable(),
  timezone,
  reason
});

export type UphRetestPath = z.infer<typeof uphRetestPathSchema>;
export type CreateUphRetestBody = z.infer<typeof createUphRetestBodySchema>;
