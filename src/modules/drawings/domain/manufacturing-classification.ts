export const DRAWING_SELECTION_PURPOSES = [
  "INQUIRY",
  "MANUFACTURING",
  "CHANGE",
  "REFERENCE"
] as const;

export type DrawingSelectionPurpose = (typeof DRAWING_SELECTION_PURPOSES)[number];

export type DrawingSelectionStatus = "DRAFT" | "LOCKED";

export type ClassificationSnapshot = Readonly<{
  categoryCode: string;
  processTagCodes: readonly string[];
}>;

export type ManufacturingClassificationErrorCode =
  | "MANUFACTURING_CATEGORY_CODE_INVALID"
  | "MANUFACTURING_CATEGORY_CODE_DUPLICATE"
  | "PROCESS_TAG_CODE_INVALID"
  | "PROCESS_TAG_CODE_DUPLICATE"
  | "DRAWING_SELECTION_PURPOSE_INVALID"
  | "DRAWING_SELECTION_QUANTITY_INVALID"
  | "DRAWING_SELECTION_SPARE_QUANTITY_INVALID"
  | "SUPPLIER_EXCEPTION_REASON_REQUIRED"
  | "DRAWING_SELECTION_STATUS_INVALID"
  | "DRAWING_SELECTION_LOCKED"
  | "MANUFACTURING_CATEGORY_INACTIVE"
  | "PROCESS_TAG_INACTIVE"
  | "MANUFACTURING_CATEGORY_NOT_FOUND"
  | "PROCESS_TAG_NOT_FOUND"
  | "DRAWING_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "INACTIVE_CLASSIFICATION"
  | "INVALID_CODE"
  | "INVALID_NAME"
  | "INVALID_SORT_ORDER"
  | "NOT_FOUND"
  | "CODE_CONFLICT"
  | "CODE_IMMUTABLE"
  | "PROCESS_TAG_DUPLICATE"
  | "SUPPLIER_REFERENCE_NOT_FOUND"
  | "SUPPLIER_MANUFACTURING_CAPABILITY_NOT_FOUND"
  | "SUPPLIER_PROCESS_CAPABILITY_NOT_FOUND";

export class ManufacturingClassificationError extends Error {
  constructor(
    readonly code: ManufacturingClassificationErrorCode,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "ManufacturingClassificationError";
  }
}

const STABLE_CODE = /^[A-Z][A-Z0-9._-]{0,63}$/u;

function normalizeStableCode(
  value: unknown,
  code: "MANUFACTURING_CATEGORY_CODE_INVALID" | "PROCESS_TAG_CODE_INVALID",
  label: string
): string {
  if (typeof value !== "string") {
    throw new ManufacturingClassificationError(code, `${label}必须是稳定代码。`);
  }
  const normalized = value.trim().toUpperCase();
  if (!STABLE_CODE.test(normalized)) {
    throw new ManufacturingClassificationError(
      code,
      `${label}必须为 1 到 64 个大写字母、数字、点、下划线或连字符。`
    );
  }
  return normalized;
}

function normalizeCodeList(
  value: unknown,
  normalizeCode: (candidate: unknown) => string,
  duplicateCode: "MANUFACTURING_CATEGORY_CODE_DUPLICATE" | "PROCESS_TAG_CODE_DUPLICATE",
  label: string
): string[] {
  if (!Array.isArray(value)) {
    throw new ManufacturingClassificationError(
      duplicateCode === "MANUFACTURING_CATEGORY_CODE_DUPLICATE"
        ? "MANUFACTURING_CATEGORY_CODE_INVALID"
        : "PROCESS_TAG_CODE_INVALID",
      `${label}必须是代码数组。`
    );
  }

  const codes = new Set<string>();
  for (const candidate of value) {
    const code = normalizeCode(candidate);
    if (codes.has(code)) {
      throw new ManufacturingClassificationError(
        duplicateCode,
        `${label}不能包含重复的稳定代码 ${code}。`,
        409
      );
    }
    codes.add(code);
  }
  return [...codes].sort();
}

export function normalizeManufacturingCategoryCode(value: unknown): string {
  return normalizeStableCode(value, "MANUFACTURING_CATEGORY_CODE_INVALID", "制造分类代码");
}

export function normalizeManufacturingCategoryCodes(value: unknown): string[] {
  return normalizeCodeList(
    value,
    normalizeManufacturingCategoryCode,
    "MANUFACTURING_CATEGORY_CODE_DUPLICATE",
    "制造分类代码"
  );
}

export function normalizeProcessTagCode(value: unknown): string {
  return normalizeStableCode(value, "PROCESS_TAG_CODE_INVALID", "工艺标签代码");
}

export function normalizeProcessTagCodes(value: unknown): string[] {
  return normalizeCodeList(
    value,
    normalizeProcessTagCode,
    "PROCESS_TAG_CODE_DUPLICATE",
    "工艺标签代码"
  );
}

export function normalizeDrawingClassification(input: {
  categoryCode: unknown;
  processTagCodes: unknown;
}): ClassificationSnapshot {
  return {
    categoryCode: normalizeManufacturingCategoryCode(input.categoryCode),
    processTagCodes: normalizeProcessTagCodes(input.processTagCodes)
  };
}

export function matchesSupplierCapability(
  requirement: ClassificationSnapshot,
  capability: ClassificationSnapshot
): boolean {
  return (
    requirement.categoryCode === capability.categoryCode &&
    requirement.processTagCodes.every((code) => capability.processTagCodes.includes(code))
  );
}

export function assertDrawingSelectionPurpose(value: unknown): DrawingSelectionPurpose {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : null;
  if (!normalized || !DRAWING_SELECTION_PURPOSES.includes(normalized as DrawingSelectionPurpose)) {
    throw new ManufacturingClassificationError(
      "DRAWING_SELECTION_PURPOSE_INVALID",
      "选图用途必须是 INQUIRY、MANUFACTURING、CHANGE 或 REFERENCE。"
    );
  }
  return normalized as DrawingSelectionPurpose;
}

export function validateDrawingSelectionQuantities(input: {
  quantity: unknown;
  spareQuantity: unknown;
}): { quantity: number; spareQuantity: number } {
  if (
    typeof input.quantity !== "number" ||
    !Number.isFinite(input.quantity) ||
    input.quantity <= 0
  ) {
    throw new ManufacturingClassificationError(
      "DRAWING_SELECTION_QUANTITY_INVALID",
      "选图数量必须是正数。"
    );
  }
  if (
    typeof input.spareQuantity !== "number" ||
    !Number.isFinite(input.spareQuantity) ||
    input.spareQuantity < 0
  ) {
    throw new ManufacturingClassificationError(
      "DRAWING_SELECTION_SPARE_QUANTITY_INVALID",
      "备品数量必须是非负数。"
    );
  }
  return { quantity: input.quantity, spareQuantity: input.spareQuantity };
}

export function validateSupplierExceptionReason(input: {
  supplierReferenceId: string | null;
  isDefaultMatch: boolean;
  exceptionReason: unknown;
}): string | null {
  const exceptionReason =
    typeof input.exceptionReason === "string" && input.exceptionReason.trim()
      ? input.exceptionReason.trim()
      : null;

  if (input.supplierReferenceId && !input.isDefaultMatch && !exceptionReason) {
    throw new ManufacturingClassificationError(
      "SUPPLIER_EXCEPTION_REASON_REQUIRED",
      "例外供应商必须填写原因。"
    );
  }
  return exceptionReason;
}

export function assertSelectionMutable(status: DrawingSelectionStatus): void {
  if (status === "DRAFT") return;
  if (status === "LOCKED") {
    throw new ManufacturingClassificationError(
      "DRAWING_SELECTION_LOCKED",
      "已锁定的选图分包不能修改。",
      409
    );
  }
  throw new ManufacturingClassificationError(
    "DRAWING_SELECTION_STATUS_INVALID",
    "选图分包状态必须是 DRAFT 或 LOCKED。"
  );
}
