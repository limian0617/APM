export const PLANNING_NODE_STATUSES = {
  ACTIVE: "ACTIVE",
  CLOSED: "CLOSED"
} as const;

export const PLANNING_TASK_STATUSES = {
  NOT_STARTED: "NOT_STARTED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  CLOSED: "CLOSED"
} as const;

export type PlanningNodeStatusCode =
  (typeof PLANNING_NODE_STATUSES)[keyof typeof PLANNING_NODE_STATUSES];
export type PlanningTaskStatusCode =
  (typeof PLANNING_TASK_STATUSES)[keyof typeof PLANNING_TASK_STATUSES];

export class PlanningError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "PlanningError";
  }
}

function requiredText(value: unknown, field: string, maximum: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximum) {
    throw new PlanningError("INVALID_PLANNING_CONTENT", `${field} 必须是 1 到 ${maximum} 个字符。`);
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  return requiredText(value, field, maximum);
}

function stableCode(value: unknown, field = "code"): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Z][A-Z0-9_.-]{1,99}$/u.test(normalized)) {
    throw new PlanningError("INVALID_PLANNING_CODE", `${field} 必须是稳定的大写代码。`);
  }
  return normalized;
}

function identifier(value: unknown, field: string): string {
  return requiredText(value, field, 191);
}

function optionalIdentifier(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return identifier(value, field);
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new PlanningError(
      "INVALID_PLANNING_NUMBER",
      `${field} 必须是 ${minimum} 到 ${maximum} 的整数。`
    );
  }
  return value as number;
}

function dateTime(value: unknown, field: string): Date {
  const date =
    value instanceof Date ? new Date(value) : new Date(typeof value === "string" ? value : "");
  if (Number.isNaN(date.valueOf())) {
    throw new PlanningError("INVALID_PLANNING_DATE", `${field} 必须是有效日期时间。`);
  }
  return date;
}

function optionalDateTime(value: unknown, field: string): Date | null {
  if (value === undefined || value === null) return null;
  return dateTime(value, field);
}

export type WbsNodeDefinition = {
  code: string;
  name: string;
  description: string | null;
  parentId: string | null;
  position: number;
};

export function buildWbsNodeDefinition(input: {
  code: unknown;
  name: unknown;
  description?: unknown;
  parentId?: unknown;
  position: unknown;
}): WbsNodeDefinition {
  return {
    code: stableCode(input.code),
    name: requiredText(input.name, "name", 200),
    description: optionalText(input.description, "description", 2000),
    parentId: optionalIdentifier(input.parentId, "parentId"),
    position: boundedInteger(input.position, "position", 0, 1_000_000)
  };
}

export function assertWbsParent(nodeId: string | null, parentId: string | null) {
  if (nodeId && nodeId === parentId) {
    throw new PlanningError("WBS_CYCLE", "WBS 节点不能以自身为父节点。", 409);
  }
}

export type PlanningTaskDefinition = {
  code: string;
  name: string;
  description: string | null;
  wbsNodeId: string;
  responsibilityPackageId: string | null;
  deliveryUnitId: string | null;
  moduleId: string | null;
  ownerMembershipId: string;
  position: number;
  plannedStartAt: Date;
  plannedFinishAt: Date;
  plannedDurationMinutes: number;
  weight: number;
};

export function buildPlanningTaskDefinition(input: {
  code: unknown;
  name: unknown;
  description?: unknown;
  wbsNodeId: unknown;
  responsibilityPackageId?: unknown;
  deliveryUnitId?: unknown;
  moduleId?: unknown;
  ownerMembershipId: unknown;
  position: unknown;
  plannedStartAt: unknown;
  plannedFinishAt: unknown;
  plannedDurationMinutes: unknown;
  weight: unknown;
}): PlanningTaskDefinition {
  const plannedStartAt = dateTime(input.plannedStartAt, "plannedStartAt");
  const plannedFinishAt = dateTime(input.plannedFinishAt, "plannedFinishAt");
  if (plannedFinishAt <= plannedStartAt) {
    throw new PlanningError(
      "INVALID_PLANNING_DATE_RANGE",
      "plannedFinishAt 必须晚于 plannedStartAt。"
    );
  }
  return {
    code: stableCode(input.code),
    name: requiredText(input.name, "name", 200),
    description: optionalText(input.description, "description", 2000),
    wbsNodeId: identifier(input.wbsNodeId, "wbsNodeId"),
    responsibilityPackageId: optionalIdentifier(
      input.responsibilityPackageId,
      "responsibilityPackageId"
    ),
    deliveryUnitId: optionalIdentifier(input.deliveryUnitId, "deliveryUnitId"),
    moduleId: optionalIdentifier(input.moduleId, "moduleId"),
    ownerMembershipId: identifier(input.ownerMembershipId, "ownerMembershipId"),
    position: boundedInteger(input.position, "position", 0, 1_000_000),
    plannedStartAt,
    plannedFinishAt,
    plannedDurationMinutes: boundedInteger(
      input.plannedDurationMinutes,
      "plannedDurationMinutes",
      1,
      5_256_000
    ),
    weight: boundedInteger(input.weight, "weight", 1, 1_000_000)
  };
}

export type PlanningTaskProgress = {
  status: Exclude<PlanningTaskStatusCode, "CLOSED">;
  actualStartAt: Date | null;
  actualFinishAt: Date | null;
  remainingDurationMinutes: number;
  forecastFinishAt: Date;
};

export function buildPlanningTaskProgress(input: {
  plannedStartAt: unknown;
  actualStartAt?: unknown;
  actualFinishAt?: unknown;
  remainingDurationMinutes: unknown;
  forecastFinishAt?: unknown;
}): PlanningTaskProgress {
  const plannedStartAt = dateTime(input.plannedStartAt, "plannedStartAt");
  const actualStartAt = optionalDateTime(input.actualStartAt, "actualStartAt");
  const actualFinishAt = optionalDateTime(input.actualFinishAt, "actualFinishAt");
  const remainingDurationMinutes = boundedInteger(
    input.remainingDurationMinutes,
    "remainingDurationMinutes",
    0,
    5_256_000
  );

  if (actualFinishAt) {
    if (!actualStartAt || actualFinishAt < actualStartAt || remainingDurationMinutes !== 0) {
      throw new PlanningError(
        "INVALID_TASK_PROGRESS",
        "完成任务必须有有效实际开始/完成时间且剩余工期为 0。",
        409
      );
    }
    return {
      status: "COMPLETED",
      actualStartAt,
      actualFinishAt,
      remainingDurationMinutes: 0,
      forecastFinishAt: actualFinishAt
    };
  }

  const forecastFinishAt = optionalDateTime(input.forecastFinishAt, "forecastFinishAt");
  if (!forecastFinishAt || remainingDurationMinutes < 1) {
    throw new PlanningError(
      "INVALID_TASK_PROGRESS",
      "未完成任务必须有预测完成时间且剩余工期大于 0。",
      409
    );
  }
  const lowerBound = actualStartAt ?? plannedStartAt;
  if (forecastFinishAt < lowerBound) {
    throw new PlanningError("INVALID_TASK_PROGRESS", "预测完成时间不能早于任务开始时间。", 409);
  }
  return {
    status: actualStartAt ? "IN_PROGRESS" : "NOT_STARTED",
    actualStartAt,
    actualFinishAt: null,
    remainingDurationMinutes,
    forecastFinishAt
  };
}

export function planningTaskAllowedActions(status: PlanningTaskStatusCode) {
  switch (status) {
    case "NOT_STARTED":
      return ["UPDATE_PLAN", "UPDATE_PROGRESS", "CLOSE"] as const;
    case "IN_PROGRESS":
      return ["UPDATE_PROGRESS", "CLOSE"] as const;
    case "COMPLETED":
      return ["UPDATE_PROGRESS", "CLOSE"] as const;
    case "CLOSED":
      return [] as const;
  }
}
