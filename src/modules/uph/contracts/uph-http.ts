import { z } from "zod";

const topologyNodeSchema: z.ZodTypeAny = z.lazy(() =>
  z.strictObject({
    sourceId: z.string().trim().min(1),
    sourceType: z.enum(["LINE", "AREA", "MACHINE", "MODULE"]),
    parentSourceId: z.string().trim().min(1).nullable(),
    relation: z.enum(["ROOT", "MANDATORY", "PARALLEL"]),
    capacity: z.number().finite().positive().optional(),
    children: z.array(topologyNodeSchema).optional()
  })
);

const topologyContentSchema = z.strictObject({
  projectShape: z.enum(["SINGLE_MACHINE", "LINE"]),
  roots: z.array(topologyNodeSchema).min(1)
});

const ctContentSchema = z.strictObject({
  projectModuleId: z.string().trim().min(1),
  intrinsicCtSeconds: z.number().finite().positive(),
  outputPerCycleTotal: z.number().int().positive(),
  parallelChannelCount: z.number().int().positive(),
  cavityCount: z.number().int().positive()
});

const formulaContentSchema = z.strictObject({
  formulaCode: z.literal("CANONICAL_UPH_V1"),
  formulaJson: z.record(z.string(), z.unknown())
});

export const uphDefinitionBodySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("TOPOLOGY"),
    content: topologyContentSchema,
    projectVersion: z.number().int().min(1)
  }),
  z.strictObject({
    kind: z.literal("CT"),
    content: ctContentSchema,
    projectVersion: z.number().int().min(1)
  }),
  z.strictObject({
    kind: z.literal("FORMULA"),
    content: formulaContentSchema,
    projectVersion: z.number().int().min(1)
  })
]);

export const uphPatchDefinitionBodySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("TOPOLOGY"),
    content: topologyContentSchema,
    projectVersion: z.number().int().min(1),
    versionId: z.string().trim().min(1),
    resourceVersion: z.number().int().min(1)
  }),
  z.strictObject({
    kind: z.literal("CT"),
    content: ctContentSchema,
    projectVersion: z.number().int().min(1),
    versionId: z.string().trim().min(1),
    resourceVersion: z.number().int().min(1)
  }),
  z.strictObject({
    kind: z.literal("FORMULA"),
    content: formulaContentSchema,
    projectVersion: z.number().int().min(1),
    versionId: z.string().trim().min(1),
    resourceVersion: z.number().int().min(1)
  })
]);

const unscopedUphCurrentSelectionQuerySchema = z.union([
  z.strictObject({ selection: z.literal("currentWork") }),
  z.strictObject({ selection: z.literal("currentPublished") })
]);

const ctCurrentSelectionQuerySchema = z.union([
  z.strictObject({
    selection: z.literal("currentWork"),
    projectModuleId: z.string().trim().min(1)
  }),
  z.strictObject({
    selection: z.literal("currentPublished"),
    projectModuleId: z.string().trim().min(1)
  })
]);

const exactUphSelectionQuerySchema = z.strictObject({
  selection: z.literal("exact"),
  versionId: z.string().trim().min(1)
});

export const uphSelectionQuerySchemaByKind = {
  TOPOLOGY: z.union([unscopedUphCurrentSelectionQuerySchema, exactUphSelectionQuerySchema]),
  CT: z.union([ctCurrentSelectionQuerySchema, exactUphSelectionQuerySchema]),
  FORMULA: z.union([unscopedUphCurrentSelectionQuerySchema, exactUphSelectionQuerySchema])
} as const;

export const uphDraftCorrectionBodySchema = z.strictObject({
  reasonCode: z.literal("DRAFT_CORRECTION"),
  reason: z.string().trim().min(1).max(1024)
});

export const uphVersionCommandBodySchema = z.strictObject({
  versionId: z.string().trim().min(1),
  resourceVersion: z.number().int().min(1)
});

export const uphDraftCorrectionCommandBodySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("TOPOLOGY"),
    reasonCode: z.literal("DRAFT_CORRECTION"),
    reason: z.string().trim().min(1).max(1024),
    content: topologyContentSchema,
    projectVersion: z.number().int().min(1)
  }),
  z.strictObject({
    kind: z.literal("CT"),
    reasonCode: z.literal("DRAFT_CORRECTION"),
    reason: z.string().trim().min(1).max(1024),
    content: ctContentSchema,
    projectVersion: z.number().int().min(1)
  }),
  z.strictObject({
    kind: z.literal("FORMULA"),
    reasonCode: z.literal("DRAFT_CORRECTION"),
    reason: z.string().trim().min(1).max(1024),
    content: formulaContentSchema,
    projectVersion: z.number().int().min(1)
  })
]);

export type UphDefinitionBody = z.infer<typeof uphDefinitionBodySchema>;
export type UphPatchDefinitionBody = z.infer<typeof uphPatchDefinitionBodySchema>;
export type UphSelectionQuery = z.infer<
  (typeof uphSelectionQuerySchemaByKind)[keyof typeof uphSelectionQuerySchemaByKind]
>;
export type UphDraftCorrectionBody = z.infer<typeof uphDraftCorrectionBodySchema>;
export type UphVersionCommandBody = z.infer<typeof uphVersionCommandBodySchema>;
export type UphDraftCorrectionCommandBody = z.infer<typeof uphDraftCorrectionCommandBodySchema>;
