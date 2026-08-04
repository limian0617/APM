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
const templateComponentTypeSchema = z.enum([
  "STAGE",
  "GATE",
  "ROLE",
  "WBS",
  "CAPABILITY_RULE",
  "MILESTONE"
]);
const stageContentSchema = z
  .strictObject({
    stages: z
      .array(
        z.strictObject({
          code: stableCodeSchema,
          name: templateNameSchema,
          description: z.string().trim().min(1).max(2000).optional(),
          sequence: z.number().int().min(0).refine(Number.isSafeInteger)
        })
      )
      .min(1)
      .max(9)
  })
  .superRefine(({ stages }, context) => {
    const codes = new Set<string>();
    const sequences = new Set<number>();
    for (const [index, stage] of stages.entries()) {
      const stageCode = /^S([0-8])$/u.exec(stage.code);
      if (!stageCode) {
        context.addIssue({
          code: "custom",
          message: "阶段代码必须是 S0 至 S8。",
          path: ["stages", index, "code"]
        });
      } else if (stage.sequence !== Number(stageCode[1])) {
        context.addIssue({
          code: "custom",
          message: "阶段顺序必须与阶段代码中的序号一致。",
          path: ["stages", index, "sequence"]
        });
      }
      if (codes.has(stage.code)) {
        context.addIssue({
          code: "custom",
          message: "阶段代码不能重复。",
          path: ["stages", index, "code"]
        });
      }
      codes.add(stage.code);
      if (sequences.has(stage.sequence)) {
        context.addIssue({
          code: "custom",
          message: "阶段顺序不能重复。",
          path: ["stages", index, "sequence"]
        });
      }
      sequences.add(stage.sequence);
    }
  });
const gateCheckerBindingSchema = z.strictObject({
  code: stableCodeSchema,
  version: z.number().int().positive().refine(Number.isSafeInteger)
});
const gateApprovalSchema = z.strictObject({
  mode: z.enum(["ALL", "ANY"]),
  projectRoles: z.array(z.enum(PROJECT_ROLE_VALUES)).min(1).max(PROJECT_ROLE_VALUES.length)
});
const legacyGateDefinitionSchema = z.strictObject({
  code: stableCodeSchema,
  name: templateNameSchema,
  stageCode: stableCodeSchema,
  requiredCheckerCodes: z.array(stableCodeSchema).min(1).max(100),
  approval: gateApprovalSchema.optional()
});
const explicitGateDefinitionSchema = z.strictObject({
  code: stableCodeSchema,
  name: templateNameSchema,
  stageCode: stableCodeSchema,
  scope: z.enum(["PROJECT", "DELIVERY_UNIT", "MODULE"]).optional(),
  checkers: z.array(gateCheckerBindingSchema).min(1).max(100),
  approval: gateApprovalSchema.optional()
});
const gateContentSchema = z
  .strictObject({
    gates: z
      .array(z.union([legacyGateDefinitionSchema, explicitGateDefinitionSchema]))
      .min(1)
      .max(100)
  })
  .superRefine(({ gates }, context) => {
    const gateCodes = new Set<string>();
    for (const [gateIndex, gate] of gates.entries()) {
      if (gateCodes.has(gate.code)) {
        context.addIssue({
          code: "custom",
          message: "Gate 代码不能重复。",
          path: ["gates", gateIndex, "code"]
        });
      }
      gateCodes.add(gate.code);
      if (!("checkers" in gate)) continue;

      const checkerBindings = new Set<string>();
      for (const [checkerIndex, checker] of gate.checkers.entries()) {
        const bindingKey = `${checker.code}@${checker.version}`;
        if (checkerBindings.has(bindingKey)) {
          context.addIssue({
            code: "custom",
            message: "Gate 检查器绑定不能重复。",
            path: ["gates", gateIndex, "checkers", checkerIndex]
          });
        }
        checkerBindings.add(bindingKey);
      }
    }
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
const milestoneContentSchema = z.strictObject({
  milestones: z
    .array(
      z.strictObject({
        code: stableCodeSchema,
        name: templateNameSchema,
        description: z.string().trim().min(1).max(2000).optional(),
        position: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
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
  }),
  z.strictObject({
    ...templateComponentDraftBase,
    componentType: z.literal("MILESTONE"),
    content: milestoneContentSchema
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
const responsibilityPackageItemSchema = z.strictObject({
  code: stableCodeSchema,
  description: z.string().trim().min(1).max(1000)
});
const responsibilityPackageDefinitionShape = {
  name: templateNameSchema,
  description: templateDescriptionSchema,
  deliveryUnitId: identifierSchema.nullable().optional(),
  moduleId: identifierSchema.nullable().optional(),
  ownerMembershipId: identifierSchema,
  inputs: z.array(responsibilityPackageItemSchema).min(1).max(100),
  outputs: z.array(responsibilityPackageItemSchema).min(1).max(100),
  acceptanceCriteria: z.array(responsibilityPackageItemSchema).min(1).max(100),
  valueWeight: z.number().int().min(1).max(1_000_000)
};
export const responsibilityPackagePathSchema = z.strictObject({
  projectId: identifierSchema,
  packageId: identifierSchema
});
export const responsibilityPackageCommandPathSchema = z.strictObject({
  projectId: identifierSchema,
  packageId: identifierSchema,
  command: z.enum(["submit", "accept", "reopen", "close"])
});
export const createResponsibilityPackageBodySchema = z.strictObject({
  code: stableCodeSchema,
  ...responsibilityPackageDefinitionShape,
  reason: reasonSchema
});
export const updateResponsibilityPackageBodySchema = z.strictObject({
  version: positiveVersionSchema,
  ...responsibilityPackageDefinitionShape,
  reason: reasonSchema
});
export const responsibilityPackageCommandBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema
});
export const responsibilityPackageQuerySchema = z.strictObject({
  status: z.enum(["OPEN", "ACCEPTANCE_PENDING", "ACCEPTED", "CLOSED"]).optional(),
  cursor: identifierSchema.optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/u)
    .optional()
    .transform((value) => (value === undefined ? 50 : Number(value)))
    .pipe(z.number().int().min(1).max(100))
});
const planningPositionSchema = z.number().int().min(0).max(1_000_000);
const planningDurationSchema = z.number().int().min(1).max(5_256_000);
const planningWeightSchema = z.number().int().min(1).max(1_000_000);
const planningDateTimeSchema = z.string().datetime({ offset: true });
const wbsNodeDefinitionShape = {
  name: templateNameSchema,
  description: templateDescriptionSchema,
  parentId: identifierSchema.nullable().optional(),
  position: planningPositionSchema
};
export const wbsNodePathSchema = z.strictObject({
  projectId: identifierSchema,
  nodeId: identifierSchema
});
export const createWbsNodeBodySchema = z.strictObject({
  code: stableCodeSchema,
  ...wbsNodeDefinitionShape,
  reason: reasonSchema
});
export const updateWbsNodeBodySchema = z.strictObject({
  version: positiveVersionSchema,
  ...wbsNodeDefinitionShape,
  reason: reasonSchema
});
export const closePlanningBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema
});
export const wbsNodeQuerySchema = z.strictObject({
  status: z.enum(["ACTIVE", "CLOSED"]).optional()
});
const planningTaskDefinitionShape = {
  name: templateNameSchema,
  description: templateDescriptionSchema,
  wbsNodeId: identifierSchema,
  responsibilityPackageId: identifierSchema.nullable().optional(),
  deliveryUnitId: identifierSchema.nullable().optional(),
  moduleId: identifierSchema.nullable().optional(),
  ownerMembershipId: identifierSchema,
  position: planningPositionSchema,
  plannedStartAt: planningDateTimeSchema,
  plannedFinishAt: planningDateTimeSchema,
  plannedDurationMinutes: planningDurationSchema,
  weight: planningWeightSchema
};
export const planningTaskPathSchema = z.strictObject({
  projectId: identifierSchema,
  taskId: identifierSchema
});
export const planningTaskCommandPathSchema = z.strictObject({
  projectId: identifierSchema,
  taskId: identifierSchema,
  command: z.enum(["progress", "close"])
});
export const createPlanningTaskBodySchema = z.strictObject({
  code: stableCodeSchema,
  ...planningTaskDefinitionShape,
  reason: reasonSchema
});
export const updatePlanningTaskBodySchema = z.strictObject({
  version: positiveVersionSchema,
  ...planningTaskDefinitionShape,
  reason: reasonSchema
});
export const planningTaskProgressBodySchema = z.strictObject({
  version: positiveVersionSchema,
  actualStartAt: planningDateTimeSchema.nullable().optional(),
  actualFinishAt: planningDateTimeSchema.nullable().optional(),
  remainingDurationMinutes: z.number().int().min(0).max(5_256_000),
  forecastFinishAt: planningDateTimeSchema.nullable().optional(),
  reason: reasonSchema
});
export const planningTaskQuerySchema = z.strictObject({
  status: z.enum(["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "CLOSED"]).optional(),
  wbsNodeId: identifierSchema.optional()
});
const workIntervalSchema = z.strictObject({
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440)
});
const weeklyWorkRuleSchema = z.strictObject({
  dayOfWeek: z.number().int().min(1).max(7),
  intervals: z.array(workIntervalSchema).min(1).max(8)
});
const calendarExceptionSchema = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  intervals: z.array(workIntervalSchema).max(8)
});
export const saveProjectCalendarBodySchema = z.strictObject({
  version: nonNegativeVersionSchema,
  name: templateNameSchema,
  timeZone: z.string().trim().min(1).max(100),
  weeklyRules: z.array(weeklyWorkRuleSchema).min(1).max(7),
  exceptions: z.array(calendarExceptionSchema).max(3660),
  reason: reasonSchema
});
export const projectCalendarCloseBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema
});
export const taskDependencyPathSchema = z.strictObject({
  projectId: identifierSchema,
  dependencyId: identifierSchema
});
const taskDependencyDefinitionShape = {
  dependencyType: z.enum(["FS", "SS", "FF"]),
  lagMinutes: z.number().int().min(-5_256_000).max(5_256_000)
};
export const createTaskDependencyBodySchema = z.strictObject({
  predecessorTaskId: identifierSchema,
  successorTaskId: identifierSchema,
  ...taskDependencyDefinitionShape,
  reason: reasonSchema
});
export const updateTaskDependencyBodySchema = z.strictObject({
  version: positiveVersionSchema,
  ...taskDependencyDefinitionShape,
  reason: reasonSchema
});
export const taskDependencyCloseBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema
});
export const taskDependencyQuerySchema = z.strictObject({
  status: z.enum(["ACTIVE", "CLOSED"]).optional()
});
export const projectMilestonePathSchema = z.strictObject({
  projectId: identifierSchema,
  milestoneId: identifierSchema
});
export const milestoneCommandPathSchema = z.strictObject({
  projectId: identifierSchema,
  milestoneId: identifierSchema,
  command: z.enum(["achieve", "void", "link-task", "void-task-link"])
});
const projectMilestoneDefinitionShape = {
  name: templateNameSchema,
  description: templateDescriptionSchema,
  position: planningPositionSchema,
  targetAt: planningDateTimeSchema.nullable().optional()
};
export const createProjectMilestoneBodySchema = z.strictObject({
  code: stableCodeSchema,
  ...projectMilestoneDefinitionShape,
  reason: reasonSchema
});
export const updateProjectMilestoneBodySchema = z.strictObject({
  version: positiveVersionSchema,
  ...projectMilestoneDefinitionShape,
  reason: reasonSchema
});
export const milestoneAchieveBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema
});
export const milestoneVoidBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema
});
export const milestoneLinkTaskBodySchema = z.strictObject({
  version: positiveVersionSchema,
  taskId: identifierSchema,
  reason: reasonSchema
});
export const milestoneVoidTaskLinkBodySchema = z.strictObject({
  version: positiveVersionSchema,
  linkId: identifierSchema,
  reason: reasonSchema
});

const projectStageStatusSchema = z.enum([
  "AUTHORIZED",
  "IN_PROGRESS",
  "AWAITING_GATE",
  "COMPLETED",
  "CONDITIONALLY_RELEASED",
  "SKIPPED"
]);
export const projectStagePathSchema = z.strictObject({
  projectId: identifierSchema,
  stageId: identifierSchema
});
export const projectStageTransitionBodySchema = z.strictObject({
  version: positiveVersionSchema,
  deliveryUnitStageId: identifierSchema.optional(),
  toStatus: projectStageStatusSchema,
  reason: reasonSchema
});
export const stageReleasePathSchema = z.strictObject({
  projectId: identifierSchema,
  releaseId: identifierSchema
});
export const createStageReleaseBodySchema = z
  .strictObject({
    scope: z.enum(["PROJECT", "DELIVERY_UNIT"]),
    fromStageId: identifierSchema,
    toStageId: identifierSchema,
    deliveryUnitId: identifierSchema.optional(),
    reason: reasonSchema
  })
  .superRefine((value, context) => {
    if (value.scope === "PROJECT" && value.deliveryUnitId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["deliveryUnitId"],
        message: "项目范围不能指定交付单元。"
      });
    }
    if (value.scope === "DELIVERY_UNIT" && value.deliveryUnitId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["deliveryUnitId"],
        message: "交付单元范围必须指定交付单元。"
      });
    }
  });
export const revokeStageReleaseBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema
});
export const gateInstancePathSchema = z.strictObject({
  projectId: identifierSchema,
  instanceId: identifierSchema
});
export const createGateInstanceBodySchema = z
  .strictObject({
    definitionId: identifierSchema,
    scope: z.enum(["DELIVERY_UNIT", "MODULE"]),
    deliveryUnitId: identifierSchema,
    moduleId: identifierSchema.optional()
  })
  .superRefine((value, context) => {
    if (value.scope === "DELIVERY_UNIT" && value.moduleId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["moduleId"],
        message: "交付单元范围不能指定模块。"
      });
    }
    if (value.scope === "MODULE" && value.moduleId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["moduleId"],
        message: "模块范围必须指定模块。"
      });
    }
  });
export const runGateChecksBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema
});
export const gateSubmissionPathSchema = z.strictObject({
  projectId: identifierSchema,
  submissionId: identifierSchema
});
export const gateSubmissionCommandBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema
});
const residualItemInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(191),
  ownerMembershipId: identifierSchema,
  verifierMembershipId: identifierSchema,
  dueAt: z.string().datetime({ offset: true }),
  evidence: z.string().trim().min(1).max(4096),
  escalationRule: z.string().trim().min(1).max(1024)
});
export const conditionalReleaseBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema,
  residualItems: z.array(residualItemInputSchema).min(1).max(100)
});
export const residualItemPathSchema = z.strictObject({
  projectId: identifierSchema,
  residualItemId: identifierSchema
});
export const residualItemCommandBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema
});
export const verifyResidualItemBodySchema = z.strictObject({
  version: positiveVersionSchema,
  decision: z.enum(["VERIFY", "RETURN"]),
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
