export const SETTING_VALUE_TYPES = {
  BOOLEAN: "BOOLEAN",
  INTEGER: "INTEGER",
  STRING: "STRING",
  JSON: "JSON"
} as const;

export type SettingValueTypeCode = (typeof SETTING_VALUE_TYPES)[keyof typeof SETTING_VALUE_TYPES];

type IntegerDefinition = {
  valueType: typeof SETTING_VALUE_TYPES.INTEGER;
  defaultValue: number;
  minimum: number;
  maximum: number;
  description: string;
};

export const RUNTIME_SETTING_DEFINITIONS = {
  "jobs.defaultMaxAttempts": {
    valueType: SETTING_VALUE_TYPES.INTEGER,
    defaultValue: 5,
    minimum: 1,
    maximum: 100,
    description: "持久作业每轮执行的最大尝试次数"
  },
  "jobs.retryBaseSeconds": {
    valueType: SETTING_VALUE_TYPES.INTEGER,
    defaultValue: 5,
    minimum: 1,
    maximum: 3600,
    description: "指数退避的基础秒数"
  },
  "jobs.retryMaxSeconds": {
    valueType: SETTING_VALUE_TYPES.INTEGER,
    defaultValue: 300,
    minimum: 1,
    maximum: 86400,
    description: "指数退避的最大秒数"
  },
  "jobs.claimBatchSize": {
    valueType: SETTING_VALUE_TYPES.INTEGER,
    defaultValue: 20,
    minimum: 1,
    maximum: 500,
    description: "Worker 单次领取作业数"
  },
  "jobs.leaseSeconds": {
    valueType: SETTING_VALUE_TYPES.INTEGER,
    defaultValue: 60,
    minimum: 5,
    maximum: 3600,
    description: "Worker 作业租约秒数"
  }
} as const satisfies Record<string, IntegerDefinition>;

export type RuntimeSettingKey = keyof typeof RUNTIME_SETTING_DEFINITIONS;

export const RUNTIME_SETTING_KEYS = Object.keys(RUNTIME_SETTING_DEFINITIONS) as RuntimeSettingKey[];

export const CAPABILITY_CODES = {
  SUPPLIER_COLLABORATION: "SUPPLIER_COLLABORATION",
  CUSTOMER_PROGRESS_SHARING: "CUSTOMER_PROGRESS_SHARING",
  AI_ISSUE_INTAKE: "AI_ISSUE_INTAKE",
  UPH_ANALYSIS: "UPH_ANALYSIS",
  INCENTIVE_MANAGEMENT: "INCENTIVE_MANAGEMENT"
} as const;

export type CapabilityCodeValue = (typeof CAPABILITY_CODES)[keyof typeof CAPABILITY_CODES];
export const CAPABILITY_CODE_VALUES = Object.values(CAPABILITY_CODES);

export class ConfigurationValidationError extends Error {
  constructor(
    readonly code:
      | "UNKNOWN_SETTING"
      | "UNKNOWN_CAPABILITY"
      | "INVALID_VALUE"
      | "INVALID_VERSION"
      | "REASON_REQUIRED"
      | "VERSION_CONFLICT",
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export function isRuntimeSettingKey(value: string): value is RuntimeSettingKey {
  return Object.hasOwn(RUNTIME_SETTING_DEFINITIONS, value);
}

export function isCapabilityCode(value: string): value is CapabilityCodeValue {
  return CAPABILITY_CODE_VALUES.includes(value as CapabilityCodeValue);
}

export function validateRuntimeSettingValue(key: string, value: unknown): number {
  if (!isRuntimeSettingKey(key)) {
    throw new ConfigurationValidationError("UNKNOWN_SETTING", "运行配置键不存在。", 404);
  }

  const definition = RUNTIME_SETTING_DEFINITIONS[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < definition.minimum ||
    value > definition.maximum
  ) {
    throw new ConfigurationValidationError(
      "INVALID_VALUE",
      `配置值必须是 ${definition.minimum} 到 ${definition.maximum} 之间的整数。`,
      422
    );
  }

  return value;
}

export function validateVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ConfigurationValidationError("INVALID_VERSION", "version 必须是正整数。", 422);
  }
  return value;
}

export function validateReason(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationValidationError("REASON_REQUIRED", "必须填写修改原因。", 422);
  }
  return value.trim().slice(0, 1024);
}
