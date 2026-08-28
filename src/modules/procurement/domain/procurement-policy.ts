export const PROCUREMENT_MODES = ["LOCAL", "ERP"] as const;

export const PROCUREMENT_BUSINESS_TYPES = [
  "STANDARD_PURCHASE",
  "DRAWING_CUSTOM",
  "OUTSOURCED_PROCESS"
] as const;

export const REQUIREMENT_STATUSES = ["DRAFT", "CONFIRMED", "SUPERSEDED", "CANCELED"] as const;

export const PROCUREMENT_DISPLAY_STATUSES = [
  "PENDING_CONFIRMATION",
  "PENDING_REQUISITION",
  "REQUISITIONED",
  "ORDERED",
  "PARTIALLY_ARRIVED",
  "PENDING_ACCEPTANCE",
  "READY",
  "OVERDUE_BLOCKED",
  "REJECTED_RETURNED",
  "CHANGE_PENDING",
  "CANCELED"
] as const;

export type ProcurementBusinessType = (typeof PROCUREMENT_BUSINESS_TYPES)[number];

export class ProcurementPolicyError extends Error {
  readonly status: number;

  constructor(
    readonly code: string,
    message: string,
    status = 422
  ) {
    super(message);
    this.name = "ProcurementPolicyError";
    this.status = status;
  }
}

export type RequirementDraft = {
  businessType: ProcurementBusinessType;
  quantity: string;
  trackingUnit: string;
  drawingId: string | null;
  drawingVersionId: string | null;
  outsourcedProcess: string | null;
};

const QUANTITY_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u;
const UNIT_PATTERN = /^[A-Z][A-Z0-9._-]{0,31}$/u;

export function validateRequirementDraft(input: RequirementDraft): RequirementDraft {
  if (!QUANTITY_PATTERN.test(input.quantity) || Number(input.quantity) <= 0) {
    throw new ProcurementPolicyError(
      "PROC_QUANTITY_INVALID",
      "quantity 必须是正数且最多 6 位小数。"
    );
  }
  if (!UNIT_PATTERN.test(input.trackingUnit)) {
    throw new ProcurementPolicyError("PROC_UNIT_INVALID", "trackingUnit 必须是受控单位代码。");
  }
  if (input.businessType === "DRAWING_CUSTOM" && (!input.drawingId || !input.drawingVersionId)) {
    throw new ProcurementPolicyError(
      "PROC_DRAWING_VERSION_REQUIRED",
      "图纸定制加工必须引用确切图纸版本。"
    );
  }
  if (input.businessType !== "DRAWING_CUSTOM" && (input.drawingId || input.drawingVersionId)) {
    throw new ProcurementPolicyError(
      "PROC_DRAWING_VERSION_NOT_ALLOWED",
      "非图纸定制需求不能携带图纸版本。"
    );
  }
  if (input.businessType === "OUTSOURCED_PROCESS" && !input.outsourcedProcess?.trim()) {
    throw new ProcurementPolicyError(
      "PROC_OUTSOURCED_PROCESS_REQUIRED",
      "委外工序必须填写工序名称。"
    );
  }
  if (input.businessType !== "OUTSOURCED_PROCESS" && input.outsourcedProcess) {
    throw new ProcurementPolicyError(
      "PROC_OUTSOURCED_PROCESS_NOT_ALLOWED",
      "非委外需求不能填写委外工序。"
    );
  }
  return {
    ...input,
    outsourcedProcess: input.outsourcedProcess?.trim() ?? null
  };
}
