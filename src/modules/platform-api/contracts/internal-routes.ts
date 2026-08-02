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

const stableCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_.-]{1,99}$/u);
const templateIdentityCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_.-]{2,100}$/u);
const templateNameSchema = z.string().trim().min(1).max(200);
const templateDescriptionSchema = z.string().trim().max(2000).nullable().optional();
const templateComponentTypeSchema = z.enum(["STAGE", "GATE", "ROLE", "WBS", "CAPABILITY_RULE"]);
const stageContentSchema = z.strictObject({
  stages: z
    .array(
      z.strictObject({
        code: stableCodeSchema,
        name: templateNameSchema,
        sequence: z.number().int().min(0)
      })
    )
    .min(1)
    .max(100)
});
const gateContentSchema = z.strictObject({
  gates: z
    .array(
      z.strictObject({
        code: stableCodeSchema,
        name: templateNameSchema,
        stageCode: stableCodeSchema,
        requiredCheckerCodes: z.array(stableCodeSchema).min(1).max(100)
      })
    )
    .min(1)
    .max(100)
});
const roleContentSchema = z.strictObject({
  roles: z
    .array(
      z.strictObject({
        code: stableCodeSchema,
        name: templateNameSchema,
        required: z.boolean()
      })
    )
    .min(1)
    .max(100)
});
const wbsContentSchema = z.strictObject({
  packages: z
    .array(
      z.strictObject({
        code: stableCodeSchema,
        name: templateNameSchema,
        stageCode: stableCodeSchema,
        weight: z.number().positive().max(1_000_000)
      })
    )
    .min(1)
    .max(1000)
});
const capabilityRuleContentSchema = z.strictObject({
  capabilities: z
    .array(
      z.strictObject({
        code: z.enum([
          "SUPPLIER_COLLABORATION",
          "CUSTOMER_PROGRESS_SHARING",
          "AI_ISSUE_INTAKE",
          "UPH_ANALYSIS",
          "INCENTIVE_MANAGEMENT"
        ]),
        required: z.boolean()
      })
    )
    .min(1)
    .max(20)
});
const templateComponentDraftBase = {
  version: nonNegativeVersionSchema,
  name: templateNameSchema,
  description: templateDescriptionSchema,
  reason: reasonSchema
};

export const templateComponentPathSchema = z.strictObject({ code: templateIdentityCodeSchema });
export const saveTemplateComponentDraftBodySchema = z.discriminatedUnion("componentType", [
  z.strictObject({
    ...templateComponentDraftBase,
    componentType: z.literal("STAGE"),
    content: stageContentSchema
  }),
  z.strictObject({
    ...templateComponentDraftBase,
    componentType: z.literal("GATE"),
    content: gateContentSchema
  }),
  z.strictObject({
    ...templateComponentDraftBase,
    componentType: z.literal("ROLE"),
    content: roleContentSchema
  }),
  z.strictObject({
    ...templateComponentDraftBase,
    componentType: z.literal("WBS"),
    content: wbsContentSchema
  }),
  z.strictObject({
    ...templateComponentDraftBase,
    componentType: z.literal("CAPABILITY_RULE"),
    content: capabilityRuleContentSchema
  })
]);
export const publishTemplateBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema
});
export const templateStatusBodySchema = z.strictObject({
  version: positiveVersionSchema,
  enabled: z.boolean(),
  reason: reasonSchema
});

const templateReferenceSchema = z.strictObject({
  componentVersionId: identifierSchema,
  componentType: templateComponentTypeSchema,
  slot: stableCodeSchema,
  position: z.number().int().min(0)
});
export const projectTemplatePathSchema = z.strictObject({ code: templateIdentityCodeSchema });
export const saveProjectTemplateDraftBodySchema = z.strictObject({
  version: nonNegativeVersionSchema,
  name: templateNameSchema,
  description: templateDescriptionSchema,
  components: z.array(templateReferenceSchema).min(1).max(1000),
  reason: reasonSchema
});
export const templateVersionPathSchema = z.strictObject({
  code: templateIdentityCodeSchema,
  version: z.string().regex(/^\d+$/u).transform(Number).pipe(positiveVersionSchema)
});
export const templateDiffQuerySchema = z.strictObject({
  toVersion: z.string().regex(/^\d+$/u).transform(Number).pipe(positiveVersionSchema)
});

export const jobPathSchema = z.strictObject({ jobId: identifierSchema });
export const replayJobBodySchema = z.strictObject({ reason: reasonSchema });

export const projectPathSchema = z.strictObject({ projectId: identifierSchema });
export const createProjectBodySchema = z.strictObject({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_.-]{2,100}$/u),
  name: z.string().trim().min(1).max(200),
  departmentId: identifierSchema.nullable().optional(),
  templateCode: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_.-]{2,100}$/u),
  templateVersion: positiveVersionSchema,
  templateChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
  reason: reasonSchema
});
const deliveryUnitDefinitionSchema = z.strictObject({
  code: stableCodeSchema,
  name: templateNameSchema,
  unitType: z.enum(["LINE", "AREA", "MACHINE"]),
  parentCode: stableCodeSchema.nullable().optional(),
  position: z.number().int().min(0)
});
const projectModuleDefinitionSchema = z.strictObject({
  code: stableCodeSchema,
  name: templateNameSchema,
  machineCode: stableCodeSchema,
  position: z.number().int().min(0)
});
export const initializeProjectStructureBodySchema = z.strictObject({
  projectVersion: positiveVersionSchema,
  projectType: z.enum(["CUSTOMER_DELIVERY", "INTERNAL_RND"]),
  equipmentShape: z.enum(["SINGLE_MACHINE", "LINE"]).nullable(),
  deliveryUnits: z.array(deliveryUnitDefinitionSchema).max(1000),
  modules: z.array(projectModuleDefinitionSchema).max(5000),
  reason: reasonSchema
});
export const deliveryUnitPathSchema = z.strictObject({
  projectId: identifierSchema,
  deliveryUnitId: identifierSchema
});
export const deliveryUnitStatusBodySchema = z.strictObject({
  version: positiveVersionSchema,
  enabled: z.boolean(),
  reason: reasonSchema
});
const projectCapabilityCodeSchema = z.enum([
  "SUPPLIER_COLLABORATION",
  "CUSTOMER_PROGRESS_SHARING",
  "AI_ISSUE_INTAKE",
  "UPH_ANALYSIS",
  "INCENTIVE_MANAGEMENT"
]);
export const confirmProjectCapabilitiesBodySchema = z.strictObject({
  projectVersion: positiveVersionSchema,
  selections: z
    .array(
      z.strictObject({
        code: projectCapabilityCodeSchema,
        enabled: z.boolean()
      })
    )
    .max(5),
  reason: reasonSchema
});
export const projectCapabilityPathSchema = z.strictObject({
  projectId: identifierSchema,
  capabilityCode: projectCapabilityCodeSchema
});
export const projectCapabilityBodySchema = z.strictObject({
  version: positiveVersionSchema,
  enabled: z.boolean(),
  reason: reasonSchema
});
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
