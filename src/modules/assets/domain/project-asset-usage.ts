import { canonicalJson, type JsonValue } from "@/modules/governance/domain/idempotency";

export const PROJECT_ASSET_USAGE_SCOPE_TYPES = ["PROJECT", "DELIVERY_UNIT", "MODULE"] as const;

export type ProjectAssetUsageScopeType = (typeof PROJECT_ASSET_USAGE_SCOPE_TYPES)[number];
export type ProjectAssetFactStatus = "ACTIVE" | "RETIRED";

export type ProjectAssetUsageErrorCode =
  | "PROJECT_ASSET_QUANTITY_INVALID"
  | "PROJECT_ASSET_CONFIGURATION_INVALID"
  | "PROJECT_ASSET_SCOPE_INVALID"
  | "PROJECT_ASSET_REFERENCE_HAS_ACTIVE_USAGE"
  | "PROJECT_ASSET_REFERENCE_RETIRED"
  | "PROJECT_ASSET_USAGE_RETIRED"
  | "PROJECT_ASSET_VERSION_CONFLICT"
  | "PROJECT_ASSET_INVALID_TRANSITION";

export class ProjectAssetUsageError extends Error {
  constructor(
    readonly code: ProjectAssetUsageErrorCode | string,
    message: string,
    readonly status = 422
  ) {
    super(message);
  }
}

function assertFiniteJson(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new ProjectAssetUsageError(
        "PROJECT_ASSET_CONFIGURATION_INVALID",
        `${path} 不能包含非有限数字或 -0。`
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteJson(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ProjectAssetUsageError(
      "PROJECT_ASSET_CONFIGURATION_INVALID",
      `${path} 必须是可序列化 JSON。`
    );
  }
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) {
      throw new ProjectAssetUsageError(
        "PROJECT_ASSET_CONFIGURATION_INVALID",
        `${path}.${key} 不能为 undefined。`
      );
    }
    assertFiniteJson(child, `${path}.${key}`);
  }
}

export function parseProjectAssetQuantity(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProjectAssetUsageError(
      "PROJECT_ASSET_QUANTITY_INVALID",
      "quantity 必须是 NUMERIC(20,6) 文本。"
    );
  }
  const quantity = value.trim();
  const match = /^(0|[1-9]\d{0,19})(?:\.(\d{1,6}))?$/u.exec(quantity);
  if (!match || quantity === "0" || /^0(?:\.0{1,6})?$/u.test(quantity)) {
    throw new ProjectAssetUsageError(
      "PROJECT_ASSET_QUANTITY_INVALID",
      "quantity 必须是最多 20 位有效数字、最多 6 位小数的正数。"
    );
  }
  if (match[1].length > 14) {
    throw new ProjectAssetUsageError(
      "PROJECT_ASSET_QUANTITY_INVALID",
      "quantity 超出 NUMERIC(20,6) 的 14 位整数精度。"
    );
  }
  const fraction = (match[2] ?? "").replace(/0+$/u, "");
  return fraction ? `${match[1]}.${fraction}` : match[1];
}

export function canonicalProjectAssetConfiguration(value: unknown): {
  value: JsonValue;
  serialized: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectAssetUsageError(
      "PROJECT_ASSET_CONFIGURATION_INVALID",
      "configuration 必须是 JSON 对象。"
    );
  }
  assertFiniteJson(value, "configuration");
  try {
    return canonicalJson(value);
  } catch {
    throw new ProjectAssetUsageError(
      "PROJECT_ASSET_CONFIGURATION_INVALID",
      "configuration 必须是可序列化 JSON 对象。"
    );
  }
}

export function assertProjectAssetUsageScope(input: {
  projectId: string;
  scopeType: unknown;
  scopeId: string;
  deliveryUnitId?: string | null;
  moduleId?: string | null;
}): asserts input is {
  projectId: string;
  scopeType: ProjectAssetUsageScopeType;
  scopeId: string;
  deliveryUnitId?: string | null;
  moduleId?: string | null;
} {
  if (!PROJECT_ASSET_USAGE_SCOPE_TYPES.includes(input.scopeType as ProjectAssetUsageScopeType)) {
    throw new ProjectAssetUsageError("PROJECT_ASSET_SCOPE_INVALID", "scopeType 不受支持。");
  }
  const deliveryUnitId = input.deliveryUnitId ?? null;
  const moduleId = input.moduleId ?? null;
  const valid =
    (input.scopeType === "PROJECT" &&
      input.scopeId === input.projectId &&
      !deliveryUnitId &&
      !moduleId) ||
    (input.scopeType === "DELIVERY_UNIT" && input.scopeId === deliveryUnitId && !moduleId) ||
    (input.scopeType === "MODULE" && input.scopeId === moduleId && Boolean(deliveryUnitId));
  if (!valid) {
    throw new ProjectAssetUsageError(
      "PROJECT_ASSET_SCOPE_INVALID",
      "scope 必须与项目、交付单元或模块的精确层级一致。"
    );
  }
}

export function assertActiveProjectAssetUsage(status: string): asserts status is "ACTIVE" {
  if (status !== "ACTIVE") {
    throw new ProjectAssetUsageError(
      "PROJECT_ASSET_USAGE_RETIRED",
      "只有 ACTIVE 使用记录可以执行该操作。",
      409
    );
  }
}

export function assertReferenceCanRetire(input: { activeUsageCount: number }): void {
  if (!Number.isSafeInteger(input.activeUsageCount) || input.activeUsageCount < 0) {
    throw new TypeError("activeUsageCount 必须是非负整数。");
  }
  if (input.activeUsageCount > 0) {
    throw new ProjectAssetUsageError(
      "PROJECT_ASSET_REFERENCE_HAS_ACTIVE_USAGE",
      "存在 ACTIVE 实际使用清单时，项目资产引用不能退役。",
      409
    );
  }
}

export function assertActiveReference(status: string): asserts status is "ACTIVE" {
  if (status !== "ACTIVE") {
    throw new ProjectAssetUsageError(
      "PROJECT_ASSET_REFERENCE_RETIRED",
      "已退役项目资产引用不能继续使用。",
      409
    );
  }
}

export function assertRetireVersion(input: {
  expectedVersion: unknown;
  actualVersion: number;
}): void {
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion !== input.actualVersion
  ) {
    throw new ProjectAssetUsageError(
      "PROJECT_ASSET_VERSION_CONFLICT",
      "资源版本已变化，请刷新后重试。",
      409
    );
  }
}
