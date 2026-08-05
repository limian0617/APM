export const RND_PROJECT_STATUSES = [
  "PROPOSED",
  "IN_DEVELOPMENT",
  "VALIDATION",
  "RELEASE_REVIEW",
  "COMPLETED",
  "CANCELED"
] as const;

export type RndProjectStatus = (typeof RND_PROJECT_STATUSES)[number];

export const TECHNICAL_ASSET_STATUSES = [
  "DRAFT",
  "VALIDATION_PENDING",
  "VALIDATED",
  "CANCELED"
] as const;

export type TechnicalAssetStatus = (typeof TECHNICAL_ASSET_STATUSES)[number];

export const TECHNICAL_ASSET_TYPES = ["MECHANICAL", "ELECTRICAL", "SOFTWARE"] as const;

export type TechnicalAssetType = (typeof TECHNICAL_ASSET_TYPES)[number];

export const TECHNICAL_ASSET_VALIDATION_DECISIONS = ["PASSED", "FAILED"] as const;

export type TechnicalAssetValidationDecision =
  (typeof TECHNICAL_ASSET_VALIDATION_DECISIONS)[number];

export type TechnicalAssetErrorCode =
  | "INVALID_RND_PROJECT_CODE"
  | "INVALID_ASSET_NUMBER"
  | "INVALID_NAME"
  | "INVALID_DESCRIPTION"
  | "INVALID_VERSION"
  | "REASON_REQUIRED"
  | "OWNER_NOT_FOUND"
  | "OWNER_DISABLED"
  | "RND_PROJECT_NOT_FOUND"
  | "TECHNICAL_ASSET_NOT_FOUND"
  | "TECHNICAL_ASSET_NUMBER_CONFLICT"
  | "RND_PROJECT_READ_ONLY"
  | "RND_PROJECT_NOT_IN_VALIDATION"
  | "VERSION_CONFLICT"
  | "INVALID_RND_PROJECT_TRANSITION"
  | "INVALID_TECHNICAL_ASSET_TRANSITION"
  | "ASSET_NOT_PENDING_VALIDATION"
  | "VALIDATOR_MUST_BE_INDEPENDENT"
  | "VALIDATOR_DISABLED";

export class TechnicalAssetError extends Error {
  constructor(
    public readonly code: TechnicalAssetErrorCode,
    message: string,
    public readonly status = 422
  ) {
    super(message);
    this.name = "TechnicalAssetError";
  }
}

const rndProjectTransitions: Record<RndProjectStatus, readonly RndProjectStatus[]> = {
  PROPOSED: ["IN_DEVELOPMENT", "CANCELED"],
  IN_DEVELOPMENT: ["VALIDATION", "CANCELED"],
  VALIDATION: ["IN_DEVELOPMENT", "RELEASE_REVIEW", "CANCELED"],
  RELEASE_REVIEW: ["IN_DEVELOPMENT", "COMPLETED", "CANCELED"],
  COMPLETED: [],
  CANCELED: []
};

const technicalAssetTransitions: Record<TechnicalAssetStatus, readonly TechnicalAssetStatus[]> = {
  DRAFT: ["VALIDATION_PENDING", "CANCELED"],
  VALIDATION_PENDING: ["DRAFT", "VALIDATED", "CANCELED"],
  VALIDATED: ["CANCELED"],
  CANCELED: []
};

function normalizedStableCode(
  value: unknown,
  code: "INVALID_RND_PROJECT_CODE" | "INVALID_ASSET_NUMBER",
  label: string
): string {
  if (typeof value !== "string") {
    throw new TechnicalAssetError(code, `${label}必须是 3 到 101 个字符的大写稳定代码。`);
  }
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_.-]{2,100}$/u.test(normalized)) {
    throw new TechnicalAssetError(code, `${label}必须是 3 到 101 个字符的大写稳定代码。`);
  }
  return normalized;
}

export function validateRndProjectCode(value: unknown): string {
  return normalizedStableCode(value, "INVALID_RND_PROJECT_CODE", "研发项目代码");
}

export function validateTechnicalAssetNumber(value: unknown): string {
  return normalizedStableCode(value, "INVALID_ASSET_NUMBER", "企业资产编号");
}

export function validateTechnicalAssetName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) {
    throw new TechnicalAssetError("INVALID_NAME", "名称必须是 1 到 200 个字符。", 422);
  }
  return value.trim();
}

export function validateTechnicalAssetDescription(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > 2000) {
    throw new TechnicalAssetError("INVALID_DESCRIPTION", "说明不能超过 2000 个字符。", 422);
  }
  return value.trim() || null;
}

export function validatePositiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TechnicalAssetError("INVALID_VERSION", "version 必须是正整数。", 422);
  }
  return value as number;
}

export function validateReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new TechnicalAssetError("REASON_REQUIRED", "操作原因必须是 1 到 1024 个字符。", 422);
  }
  return value.trim();
}

export function allowedRndProjectTransition(from: RndProjectStatus, to: RndProjectStatus): boolean {
  return rndProjectTransitions[from].includes(to);
}

export function allowedTechnicalAssetTransition(
  from: TechnicalAssetStatus,
  to: TechnicalAssetStatus
): boolean {
  return technicalAssetTransitions[from].includes(to);
}

export function assertRndProjectTransition(from: RndProjectStatus, to: RndProjectStatus): void {
  if (!allowedRndProjectTransition(from, to)) {
    throw new TechnicalAssetError(
      "INVALID_RND_PROJECT_TRANSITION",
      `研发项目不能从 ${from} 转换到 ${to}。`,
      409
    );
  }
}

export function assertTechnicalAssetTransition(
  from: TechnicalAssetStatus,
  to: TechnicalAssetStatus
): void {
  if (!allowedTechnicalAssetTransition(from, to)) {
    throw new TechnicalAssetError(
      "INVALID_TECHNICAL_ASSET_TRANSITION",
      `企业技术资产不能从 ${from} 转换到 ${to}。`,
      409
    );
  }
}

export function assertIndependentValidator(
  ownerId: string,
  validatorId: string,
  validatorStatus: "ACTIVE" | "DISABLED"
): void {
  if (ownerId === validatorId) {
    throw new TechnicalAssetError(
      "VALIDATOR_MUST_BE_INDEPENDENT",
      "资产 Owner 不能验证自己的资产。"
    );
  }
  if (validatorStatus !== "ACTIVE") {
    throw new TechnicalAssetError("VALIDATOR_DISABLED", "验证人必须处于启用状态。", 409);
  }
}

export function nextTechnicalAssetStatusForValidation(
  current: TechnicalAssetStatus,
  decision: TechnicalAssetValidationDecision
): TechnicalAssetStatus {
  if (current !== "VALIDATION_PENDING") {
    throw new TechnicalAssetError(
      "ASSET_NOT_PENDING_VALIDATION",
      "只有待验证资产可以记录验证结论。",
      409
    );
  }
  return decision === "PASSED" ? "VALIDATED" : "DRAFT";
}
