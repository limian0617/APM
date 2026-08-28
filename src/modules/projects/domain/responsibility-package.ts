export const RESPONSIBILITY_PACKAGE_STATUSES = {
  OPEN: "OPEN",
  ACCEPTANCE_PENDING: "ACCEPTANCE_PENDING",
  ACCEPTED: "ACCEPTED",
  CLOSED: "CLOSED"
} as const;

export const RESPONSIBILITY_PACKAGE_TRANSITIONS = {
  ACCEPTANCE_SUBMITTED: "ACCEPTANCE_SUBMITTED",
  ACCEPTED: "ACCEPTED",
  REOPENED: "REOPENED",
  CLOSED: "CLOSED"
} as const;

export type ResponsibilityPackageStatusCode =
  (typeof RESPONSIBILITY_PACKAGE_STATUSES)[keyof typeof RESPONSIBILITY_PACKAGE_STATUSES];
export type ResponsibilityPackageTransitionCode =
  (typeof RESPONSIBILITY_PACKAGE_TRANSITIONS)[keyof typeof RESPONSIBILITY_PACKAGE_TRANSITIONS];

export type ResponsibilityPackageItem = {
  code: string;
  description: string;
};

export type ResponsibilityPackageDefinition = {
  code: string;
  name: string;
  description: string | null;
  deliveryUnitId: string | null;
  moduleId: string | null;
  ownerMembershipId: string;
  inputs: ResponsibilityPackageItem[];
  outputs: ResponsibilityPackageItem[];
  acceptanceCriteria: ResponsibilityPackageItem[];
  valueWeight: number;
};

export class ResponsibilityPackageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "ResponsibilityPackageError";
  }
}

function stableCode(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Z][A-Z0-9_.-]{1,99}$/u.test(normalized)) {
    throw new ResponsibilityPackageError(
      "INVALID_RESPONSIBILITY_PACKAGE_CODE",
      `${field} 必须是稳定的大写代码。`
    );
  }
  return normalized;
}

function requiredText(value: unknown, field: string, maximum: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximum) {
    throw new ResponsibilityPackageError(
      "INVALID_RESPONSIBILITY_PACKAGE_CONTENT",
      `${field} 必须是 1 到 ${maximum} 个字符。`
    );
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  return requiredText(value, field, maximum);
}

function identifier(value: unknown, field: string): string {
  return requiredText(value, field, 191);
}

function optionalIdentifier(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return identifier(value, field);
}

function items(
  value: ReadonlyArray<{ code: unknown; description: unknown }>,
  field: string
): ResponsibilityPackageItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new ResponsibilityPackageError(
      "INVALID_RESPONSIBILITY_PACKAGE_CONTENT",
      `${field} 必须包含 1 到 100 项。`
    );
  }
  const normalized = value.map((item, index) => ({
    code: stableCode(item.code, `${field}.${index}.code`),
    description: requiredText(item.description, `${field}.${index}.description`, 1000)
  }));
  if (new Set(normalized.map(({ code }) => code)).size !== normalized.length) {
    throw new ResponsibilityPackageError(
      "DUPLICATE_RESPONSIBILITY_PACKAGE_ITEM",
      `${field} 中的代码不能重复。`,
      409
    );
  }
  return normalized;
}

export function buildResponsibilityPackageDefinition(input: {
  code: unknown;
  name: unknown;
  description?: unknown;
  deliveryUnitId?: unknown;
  moduleId?: unknown;
  ownerMembershipId: unknown;
  inputs: ReadonlyArray<{ code: unknown; description: unknown }>;
  outputs: ReadonlyArray<{ code: unknown; description: unknown }>;
  acceptanceCriteria: ReadonlyArray<{ code: unknown; description: unknown }>;
  valueWeight: unknown;
}): ResponsibilityPackageDefinition {
  if (
    !Number.isSafeInteger(input.valueWeight) ||
    (input.valueWeight as number) < 1 ||
    (input.valueWeight as number) > 1_000_000
  ) {
    throw new ResponsibilityPackageError(
      "INVALID_RESPONSIBILITY_PACKAGE_WEIGHT",
      "valueWeight 必须是 1 到 1000000 的非货币整数权重。"
    );
  }
  return {
    code: stableCode(input.code, "code"),
    name: requiredText(input.name, "name", 200),
    description: optionalText(input.description, "description", 2000),
    deliveryUnitId: optionalIdentifier(input.deliveryUnitId, "deliveryUnitId"),
    moduleId: optionalIdentifier(input.moduleId, "moduleId"),
    ownerMembershipId: identifier(input.ownerMembershipId, "ownerMembershipId"),
    inputs: items(input.inputs, "inputs"),
    outputs: items(input.outputs, "outputs"),
    acceptanceCriteria: items(input.acceptanceCriteria, "acceptanceCriteria"),
    valueWeight: input.valueWeight as number
  };
}

export function nextResponsibilityPackageState(
  status: ResponsibilityPackageStatusCode,
  transition: ResponsibilityPackageTransitionCode,
  acceptanceCycle: number
): { status: ResponsibilityPackageStatusCode; acceptanceCycle: number } {
  if (!Number.isSafeInteger(acceptanceCycle) || acceptanceCycle < 0) {
    throw new ResponsibilityPackageError("INVALID_ACCEPTANCE_CYCLE", "验收轮次无效。", 409);
  }
  if (status === "OPEN" && transition === "ACCEPTANCE_SUBMITTED") {
    return { status: "ACCEPTANCE_PENDING", acceptanceCycle: acceptanceCycle + 1 };
  }
  if (status === "ACCEPTANCE_PENDING" && transition === "ACCEPTED") {
    return { status: "ACCEPTED", acceptanceCycle };
  }
  if (status === "ACCEPTED" && transition === "REOPENED") {
    return { status: "OPEN", acceptanceCycle };
  }
  if ((status === "OPEN" || status === "ACCEPTED") && transition === "CLOSED") {
    return { status: "CLOSED", acceptanceCycle };
  }
  throw new ResponsibilityPackageError(
    "RESPONSIBILITY_PACKAGE_TRANSITION_INVALID",
    `不能从 ${status} 执行 ${transition}。`,
    409
  );
}

export function responsibilityPackageAllowedActions(status: ResponsibilityPackageStatusCode) {
  switch (status) {
    case "OPEN":
      return ["UPDATE", "SUBMIT_ACCEPTANCE", "CLOSE"] as const;
    case "ACCEPTANCE_PENDING":
      return ["ACCEPT"] as const;
    case "ACCEPTED":
      return ["REOPEN", "CLOSE"] as const;
    case "CLOSED":
      return [] as const;
  }
}
