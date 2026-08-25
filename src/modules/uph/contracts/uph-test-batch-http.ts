import { z } from "zod";

const identifier = z.string().trim().min(1).max(191);
const resourceVersion = z.number().int().min(1);
const planDeclarationReason = z.string().trim().min(1).max(1024);
const timestamp = z.string().datetime({ offset: true });
const timezone = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
        return true;
      } catch {
        return false;
      }
    },
    { message: "timezone must be a valid IANA timezone" }
  );
const decimalSeconds = z
  .string()
  .regex(/^\d{1,14}(?:\.\d{1,6})?$/u)
  .refine((value) => !/^0+(?:\.0+)?$/u.test(value));
const positiveSafeInteger = z
  .number()
  .int()
  .positive()
  .refine((value) => Number.isSafeInteger(value));
const nonnegativeSafeInteger = z
  .number()
  .int()
  .nonnegative()
  .refine((value) => Number.isSafeInteger(value));
const appendExclusionReasonCode = z.enum([
  "SETUP_OR_CHANGEOVER",
  "EXTERNAL_WAITING",
  "UPSTREAM_MATERIAL_STARVATION",
  "DOWNSTREAM_BLOCKAGE",
  "SAFETY_INTERLOCK",
  "CAPTURE_DEVICE_FAULT",
  "OBSERVATION_INTERRUPTED"
]);

export const createUphTestBatchBodySchema = z.strictObject({
  batchNumber: identifier,
  topologyRootNodeId: identifier,
  plannedProductionSeconds: positiveSafeInteger,
  planDeclarationReason,
  observationStartedAt: timestamp,
  observationEndedAt: timestamp.nullable(),
  timezone
});

export const patchUphTestBatchRevisionBodySchema = z.strictObject({
  resourceVersion,
  plannedProductionSeconds: positiveSafeInteger,
  planDeclarationReason,
  observationStartedAt: timestamp,
  observationEndedAt: timestamp.nullable(),
  timezone
});

export const appendUphCycleSampleBodySchema = z
  .strictObject({
    resourceVersion,
    projectModuleId: identifier,
    ordinal: z.number().int().positive(),
    sourceEventId: identifier.nullable().optional(),
    cycleDurationSeconds: decimalSeconds,
    observedAt: timestamp,
    captureMethod: z.enum(["DEVICE_EVENT", "MANUAL_ENTRY"]),
    disposition: z.enum(["INCLUDED", "EXCLUDED"]),
    exclusionReasonCode: appendExclusionReasonCode.optional()
  })
  .superRefine((value, context) => {
    if (value.captureMethod === "DEVICE_EVENT" && !value.sourceEventId) {
      context.addIssue({ code: "custom", message: "DEVICE_EVENT requires sourceEventId" });
    }
    if (value.disposition === "EXCLUDED" && !value.exclusionReasonCode) {
      context.addIssue({ code: "custom", message: "EXCLUDED requires exclusionReasonCode" });
    }
    if (value.disposition === "INCLUDED" && value.exclusionReasonCode) {
      context.addIssue({ code: "custom", message: "INCLUDED cannot have exclusionReasonCode" });
    }
  });

export const correctUphCycleSampleBodySchema = z.strictObject({
  resourceVersion,
  replacement: z.strictObject({
    cycleDurationSeconds: decimalSeconds,
    observedAt: timestamp,
    captureMethod: z.literal("MANUAL_ENTRY")
  })
});

export const updateUphTestBatchProductionCountBodySchema = z
  .strictObject({
    resourceVersion,
    actualGrossOutputCount: nonnegativeSafeInteger,
    finalGoodOutputCount: nonnegativeSafeInteger
  })
  .refine((value) => value.finalGoodOutputCount <= value.actualGrossOutputCount, {
    message: "finalGoodOutputCount must not exceed actualGrossOutputCount"
  });

export const updateUphTestBatchModuleQualityCountBodySchema = z
  .strictObject({
    resourceVersion,
    qualityInputCount: nonnegativeSafeInteger,
    firstPassGoodCount: nonnegativeSafeInteger,
    firstPassNonconformingCount: nonnegativeSafeInteger,
    reworkInputCount: nonnegativeSafeInteger,
    reworkRecoveredGoodCount: nonnegativeSafeInteger
  })
  .refine(
    (value) =>
      value.qualityInputCount === value.firstPassGoodCount + value.firstPassNonconformingCount &&
      value.reworkRecoveredGoodCount <= value.reworkInputCount &&
      value.reworkInputCount <= value.firstPassNonconformingCount,
    { message: "module quality counts are inconsistent" }
  );

export const attachUphTestBatchRevisionEvidenceBodySchema = z.strictObject({
  resourceVersion,
  fileObjectId: identifier,
  purpose: z
    .enum(["ROOT_PRODUCTION", "MODULE_QUALITY", "CYCLE_SAMPLE", "PROTOCOL", "OBSERVATION_WINDOW"])
    .optional(),
  sampleId: identifier.optional()
});

export const confirmUphTestBatchBodySchema = z.strictObject({ resourceVersion });
export const lockUphTestBatchBodySchema = z.strictObject({ resourceVersion });
export const replaceUphTestBatchRevisionBodySchema = z.strictObject({
  resourceVersion,
  reason: z.string().trim().min(1).max(1024)
});

export const listUphTestBatchesQuerySchema = z.strictObject({
  cursor: identifier.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(["DRAFT", "PM_CONFIRMED", "LOCKED", "SUPERSEDED"]).optional(),
  topologyRootNodeId: identifier.optional()
});

export const getUphTestBatchQuerySchema = z
  .strictObject({
    selection: z.enum(["exact", "currentWork", "currentLocked"]),
    revisionId: identifier.optional()
  })
  .superRefine((value, context) => {
    if (value.selection === "exact" && !value.revisionId) {
      context.addIssue({ code: "custom", message: "exact selection requires revisionId" });
    }
    if (value.selection !== "exact" && value.revisionId) {
      context.addIssue({ code: "custom", message: "current selection cannot include revisionId" });
    }
  });
