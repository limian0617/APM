import { z } from "zod";

import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  identifierSchema,
  nonNegativeVersionSchema,
  positiveVersionSchema,
  reasonSchema
} from "@/modules/platform-api/contracts/dto";
import { ProcurementServiceError } from "@/modules/procurement/application/material-requirement-service";
import { ProcurementSettingsError } from "@/modules/procurement/application/procurement-settings-service";
import { ProcurementTrackingError } from "@/modules/procurement/application/procurement-tracking-service";

const quantitySchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u)
  .refine((value) => Number(value) > 0, {
    message: "quantity 必须是正数且最多 6 位小数。"
  });
const unitSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9._-]{0,31}$/u);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const sourceSchema = z.enum(["LOCAL", "ERP"]);
const businessTypeSchema = z.enum(["STANDARD_PURCHASE", "DRAWING_CUSTOM", "OUTSOURCED_PROCESS"]);
const requirementSourceSchema = z.enum([
  "ERP_BOM_MRP",
  "DRAWING_PUBLISHED",
  "EXCEL",
  "MANUAL",
  "CHANGE",
  "ISSUE",
  "SPARE_PART"
]);

const requirementFields = {
  materialReferenceId: identifierSchema,
  deliveryUnitId: identifierSchema.nullable().optional(),
  moduleId: identifierSchema.nullable().optional(),
  responsibilityPackageId: identifierSchema.nullable().optional(),
  taskId: identifierSchema.nullable().optional(),
  quantity: quantitySchema,
  trackingUnit: unitSchema,
  requiredOn: dateSchema,
  predictedAssemblyStartOn: dateSchema.nullable().optional(),
  isCritical: z.boolean(),
  businessType: businessTypeSchema,
  sourceType: requirementSourceSchema,
  sourceReference: z.string().trim().max(1024).nullable().optional(),
  sourceVersion: identifierSchema.nullable().optional(),
  drawingId: identifierSchema.nullable().optional(),
  drawingVersionId: identifierSchema.nullable().optional(),
  outsourcedProcess: z.string().trim().max(191).nullable().optional()
};

function refineRequirement(
  value: {
    businessType: string;
    drawingId?: string | null;
    drawingVersionId?: string | null;
    outsourcedProcess?: string | null;
  },
  context: z.RefinementCtx
) {
  if (value.businessType === "DRAWING_CUSTOM" && (!value.drawingId || !value.drawingVersionId)) {
    context.addIssue({
      code: "custom",
      path: ["drawingVersionId"],
      message: "图纸定制加工必须引用确切图纸版本。"
    });
  }
  if (value.businessType !== "DRAWING_CUSTOM" && (value.drawingId || value.drawingVersionId)) {
    context.addIssue({
      code: "custom",
      path: ["drawingVersionId"],
      message: "非图纸定制需求不能携带图纸版本。"
    });
  }
  if (value.businessType === "OUTSOURCED_PROCESS" && !value.outsourcedProcess?.trim()) {
    context.addIssue({
      code: "custom",
      path: ["outsourcedProcess"],
      message: "委外工序必须填写。"
    });
  }
}

export const createMaterialRequirementBodySchema = z
  .strictObject(requirementFields)
  .superRefine(refineRequirement);
export const reviseMaterialRequirementBodySchema = z
  .strictObject({
    ...requirementFields,
    version: positiveVersionSchema,
    reason: reasonSchema
  })
  .superRefine(refineRequirement);
export const requirementCommandBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema
});
export const procurementCommandSchema = z.enum(["confirm", "revise", "cancel"]);
export type ReviseMaterialRequirementBody = z.infer<typeof reviseMaterialRequirementBodySchema>;
export type RequirementCommandBody = z.infer<typeof requirementCommandBodySchema>;

export const procurementSettingsBodySchema = z.strictObject({
  mode: z.enum(["LOCAL", "ERP"]),
  sourceSystem: identifierSchema.nullable().optional(),
  version: nonNegativeVersionSchema,
  reason: reasonSchema
});
export const createMaterialReferenceBodySchema = z.strictObject({
  source: sourceSchema,
  externalId: identifierSchema.nullable().optional(),
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/u),
  name: z.string().trim().min(1).max(200),
  specification: z.string().trim().max(200).nullable().optional(),
  trackingUnit: unitSchema,
  defaultProcurementDays: z.number().int().min(0).nullable().optional(),
  isLongLead: z.boolean().optional()
});
export const createSupplierReferenceBodySchema = z.strictObject({
  source: sourceSchema,
  externalId: identifierSchema.nullable().optional(),
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/u),
  name: z.string().trim().min(1).max(200)
});
const trackingExternalReferenceSchema = z.string().trim().min(1).max(191).nullable().optional();
const trackingDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .nullable()
  .optional();
export const createProcurementTrackingLineBodySchema = z.strictObject({
  requirementId: identifierSchema,
  requirementRevisionId: identifierSchema,
  supplierReferenceId: identifierSchema.nullable().optional(),
  responsibleMembershipId: identifierSchema.nullable().optional(),
  businessType: businessTypeSchema,
  orderedQuantity: quantitySchema,
  requisitionObjectType: trackingExternalReferenceSchema,
  requisitionExternalId: trackingExternalReferenceSchema,
  requisitionExternalLineId: trackingExternalReferenceSchema,
  orderObjectType: trackingExternalReferenceSchema,
  orderExternalId: trackingExternalReferenceSchema,
  orderExternalLineId: trackingExternalReferenceSchema,
  orderedOn: trackingDateSchema,
  promisedOn: trackingDateSchema,
  supplierConfirmationStatus: trackingExternalReferenceSchema,
  externalStatus: trackingExternalReferenceSchema,
  reason: reasonSchema
});
export const updateProcurementTrackingLineBodySchema = z.strictObject({
  version: positiveVersionSchema,
  orderedQuantity: quantitySchema.optional(),
  supplierReferenceId: identifierSchema.nullable().optional(),
  responsibleMembershipId: identifierSchema.nullable().optional(),
  requisitionObjectType: trackingExternalReferenceSchema,
  requisitionExternalId: trackingExternalReferenceSchema,
  requisitionExternalLineId: trackingExternalReferenceSchema,
  orderObjectType: trackingExternalReferenceSchema,
  orderExternalId: trackingExternalReferenceSchema,
  orderExternalLineId: trackingExternalReferenceSchema,
  orderedOn: trackingDateSchema,
  promisedOn: trackingDateSchema,
  supplierConfirmationStatus: trackingExternalReferenceSchema,
  externalStatus: trackingExternalReferenceSchema,
  reason: reasonSchema
});
export const procurementListQuerySchema = z.strictObject({
  status: z.string().trim().min(1).max(32).optional(),
  cursor: identifierSchema.optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/u)
    .optional()
    .transform((value) => (value === undefined ? 50 : Number(value)))
    .pipe(z.number().int().min(1).max(100))
});

export function parseMaterialRequirementBody(input: unknown) {
  const result = createMaterialRequirementBodySchema.safeParse(input);
  if (!result.success) return null;
  return {
    ...result.data,
    source: result.data.sourceType
  };
}

type ProcurementServiceFailure = { code: string; message: string; status: number };

export function procurementServiceErrorResponse(error: unknown): Response | null {
  const failure =
    error instanceof ProcurementServiceError ||
    error instanceof ProcurementSettingsError ||
    error instanceof ProcurementTrackingError
      ? error
      : isProcurementServiceFailure(error)
        ? error
        : null;
  if (!failure) return null;
  return apiErrorResponse({ status: failure.status, code: failure.code, message: failure.message });
}

function isProcurementServiceFailure(error: unknown): error is ProcurementServiceFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { status?: unknown }).status === "number"
  );
}
