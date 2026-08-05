export const ALERT_SOURCE_TYPES = {
  SCHEDULE_FORECAST_STALE: "SCHEDULE_FORECAST_STALE",
  CRITICAL_TASK_DELAY: "CRITICAL_TASK_DELAY",
  MILESTONE_OVERDUE: "MILESTONE_OVERDUE",
  GATE_HARD_FAILURE: "GATE_HARD_FAILURE",
  RESIDUAL_ITEM_OVERDUE: "RESIDUAL_ITEM_OVERDUE"
} as const;

export type AlertSourceType = (typeof ALERT_SOURCE_TYPES)[keyof typeof ALERT_SOURCE_TYPES];

export const ALERT_RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type AlertRiskLevel = (typeof ALERT_RISK_LEVELS)[number];

export type AlertStatus = "TRIGGERED" | "ACKNOWLEDGED" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
export type AlertAction = "ACKNOWLEDGE" | "START" | "RESOLVE" | "CLOSE" | "RETRIGGER";

export class AlertValidationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AlertValidationError(`${field} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > 3650) {
    throw new AlertValidationError(`${field} 必须是 ${minimum} 到 3650 的整数。`);
  }
  return value as number;
}

function sourceType(value: unknown): AlertSourceType {
  if (!Object.values(ALERT_SOURCE_TYPES).includes(value as AlertSourceType)) {
    throw new AlertValidationError("预警来源未注册。 ");
  }
  return value as AlertSourceType;
}

export function validateAlertRuleConfig(source: unknown, value: unknown) {
  const type = sourceType(source);
  const config = record(value, "condition");
  if (type === ALERT_SOURCE_TYPES.SCHEDULE_FORECAST_STALE) {
    return { maximumAgeDays: nonNegativeInteger(config.maximumAgeDays, "maximumAgeDays", 1) };
  }
  if (
    type === ALERT_SOURCE_TYPES.CRITICAL_TASK_DELAY ||
    type === ALERT_SOURCE_TYPES.MILESTONE_OVERDUE
  ) {
    return { thresholdDays: nonNegativeInteger(config.thresholdDays, "thresholdDays", 0) };
  }
  if (Object.keys(config).length > 0) {
    throw new AlertValidationError(`${type} 不接受条件参数。`);
  }
  return {};
}

export function buildAlertSourceKey(source: unknown, sourceId: unknown): string {
  const type = sourceType(source);
  if (typeof sourceId !== "string") throw new AlertValidationError("sourceId 必须是字符串。 ");
  const normalized = sourceId.trim();
  if (!normalized || normalized.length > 191 || normalized.includes(":")) {
    throw new AlertValidationError("sourceId 必须是 1 到 191 个不含冒号的字符。 ");
  }
  return `${type}:${normalized}`;
}

const transitions: Readonly<Record<AlertStatus, Partial<Record<AlertAction, AlertStatus>>>> = {
  TRIGGERED: { ACKNOWLEDGE: "ACKNOWLEDGED", START: "IN_PROGRESS", RESOLVE: "RESOLVED" },
  ACKNOWLEDGED: { START: "IN_PROGRESS", RESOLVE: "RESOLVED" },
  IN_PROGRESS: { RESOLVE: "RESOLVED" },
  RESOLVED: { CLOSE: "CLOSED", RETRIGGER: "TRIGGERED" },
  CLOSED: {}
};

export function nextAlertStatus(status: AlertStatus, action: AlertAction): AlertStatus {
  const next = transitions[status]?.[action];
  if (!next) throw new AlertValidationError(`预警状态 ${status} 不能执行 ${action}。`);
  return next;
}
