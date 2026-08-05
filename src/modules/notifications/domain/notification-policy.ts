export const NOTIFICATION_SENSITIVITIES = {
  INTERNAL: "INTERNAL",
  RESTRICTED: "RESTRICTED"
} as const;

export const NOTIFICATION_CHANNELS = { EMAIL: "EMAIL" } as const;

export type NotificationSensitivity =
  (typeof NOTIFICATION_SENSITIVITIES)[keyof typeof NOTIFICATION_SENSITIVITIES];
export type TemplateVariableType = "string" | "number" | "boolean";
export type TemplateVariableSchema = Record<
  string,
  { type: TemplateVariableType; required: boolean }
>;

export class NotificationValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
  }
}

const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_-]{0,63})\s*\}\}/gu;

export function validateTemplateCode(value: unknown): string {
  if (typeof value !== "string") {
    throw new NotificationValidationError("INVALID_TEMPLATE_CODE", "模板代码必须是字符串。");
  }
  const code = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_.-]{2,100}$/u.test(code)) {
    throw new NotificationValidationError("INVALID_TEMPLATE_CODE", "模板代码格式无效。");
  }
  return code;
}

export function parseVariableSchema(value: unknown): TemplateVariableSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NotificationValidationError("INVALID_VARIABLE_SCHEMA", "变量 Schema 必须是对象。");
  }
  const schema: TemplateVariableSchema = {};
  for (const [name, definition] of Object.entries(value)) {
    if (
      !VARIABLE_NAME.test(name) ||
      !definition ||
      typeof definition !== "object" ||
      Array.isArray(definition)
    ) {
      throw new NotificationValidationError("INVALID_VARIABLE_SCHEMA", `变量 ${name} 的定义无效。`);
    }
    const record = definition as Record<string, unknown>;
    if (!["string", "number", "boolean"].includes(record.type as string)) {
      throw new NotificationValidationError("INVALID_VARIABLE_SCHEMA", `变量 ${name} 的类型无效。`);
    }
    if (record.required !== undefined && typeof record.required !== "boolean") {
      throw new NotificationValidationError(
        "INVALID_VARIABLE_SCHEMA",
        `变量 ${name} 的 required 无效。`
      );
    }
    const unknownKeys = Object.keys(record).filter((key) => key !== "type" && key !== "required");
    if (unknownKeys.length > 0) {
      throw new NotificationValidationError(
        "INVALID_VARIABLE_SCHEMA",
        `变量 ${name} 包含未知规则。`
      );
    }
    schema[name] = {
      type: record.type as TemplateVariableType,
      required: record.required !== false
    };
  }
  return schema;
}

function templateText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new NotificationValidationError("INVALID_TEMPLATE", `${field} 必须是字符串。`);
  }
  const text = value.trim();
  if (!text || text.length > maximum) {
    throw new NotificationValidationError(
      "INVALID_TEMPLATE",
      `${field} 必须是 1 到 ${maximum} 个字符。`
    );
  }
  return text;
}

function placeholders(template: string): string[] {
  return Array.from(template.matchAll(PLACEHOLDER), (match) => match[1]!).filter(
    (name, index, all) => all.indexOf(name) === index
  );
}

export function validateTemplateDefinition(input: {
  subjectTemplate: unknown;
  bodyTextTemplate: unknown;
  bodyHtmlTemplate?: unknown;
  variableSchema: unknown;
}) {
  const subjectTemplate = templateText(input.subjectTemplate, "subjectTemplate", 998);
  const bodyTextTemplate = templateText(input.bodyTextTemplate, "bodyTextTemplate", 100_000);
  const bodyHtmlTemplate =
    input.bodyHtmlTemplate === undefined || input.bodyHtmlTemplate === null
      ? null
      : templateText(input.bodyHtmlTemplate, "bodyHtmlTemplate", 200_000);
  const variableSchema = parseVariableSchema(input.variableSchema);
  for (const name of [
    ...placeholders(subjectTemplate),
    ...placeholders(bodyTextTemplate),
    ...(bodyHtmlTemplate ? placeholders(bodyHtmlTemplate) : [])
  ]) {
    if (!variableSchema[name]) {
      throw new NotificationValidationError(
        "UNKNOWN_TEMPLATE_VARIABLE",
        `模板引用了 Schema 中不存在的变量 ${name}。`
      );
    }
  }
  return { subjectTemplate, bodyTextTemplate, bodyHtmlTemplate, variableSchema };
}

function validateVariables(schema: TemplateVariableSchema, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NotificationValidationError("INVALID_TEMPLATE_VARIABLES", "模板变量必须是对象。");
  }
  const variables = value as Record<string, unknown>;
  const unknown = Object.keys(variables).filter((name) => !schema[name]);
  if (unknown.length > 0) {
    throw new NotificationValidationError(
      "UNKNOWN_TEMPLATE_VARIABLE",
      `模板变量包含未声明字段 ${unknown[0]}。`
    );
  }
  for (const [name, definition] of Object.entries(schema)) {
    const variable = variables[name];
    if (variable === undefined || variable === null) {
      if (definition.required) {
        throw new NotificationValidationError(
          "MISSING_TEMPLATE_VARIABLE",
          `模板变量 ${name} 必填。`
        );
      }
      continue;
    }
    if (typeof variable !== definition.type) {
      throw new NotificationValidationError(
        "TEMPLATE_VARIABLE_TYPE_MISMATCH",
        `模板变量 ${name} 必须是 ${definition.type}。`
      );
    }
  }
  return variables;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function render(text: string, variables: Record<string, unknown>, html: boolean): string {
  return text.replace(PLACEHOLDER, (_, name: string) => {
    const raw = variables[name];
    const value = raw === undefined || raw === null ? "" : String(raw);
    return html ? escapeHtml(value) : value;
  });
}

export function renderNotificationTemplate(input: {
  subjectTemplate: string;
  bodyTextTemplate: string;
  bodyHtmlTemplate: string | null;
  variableSchema: unknown;
  variables: unknown;
}) {
  const schema = parseVariableSchema(input.variableSchema);
  const variables = validateVariables(schema, input.variables);
  return {
    subject: render(input.subjectTemplate, variables, false),
    bodyText: render(input.bodyTextTemplate, variables, false),
    bodyHtml: input.bodyHtmlTemplate ? render(input.bodyHtmlTemplate, variables, true) : null
  };
}

export function validateSensitivity(value: unknown): NotificationSensitivity {
  const sensitivity = value ?? NOTIFICATION_SENSITIVITIES.INTERNAL;
  if (!Object.values(NOTIFICATION_SENSITIVITIES).includes(sensitivity as NotificationSensitivity)) {
    throw new NotificationValidationError("INVALID_SENSITIVITY", "通知密级无效。");
  }
  return sensitivity as NotificationSensitivity;
}

export function validateTargetPath(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\u0000-\u001f]/u.test(value)
  ) {
    throw new NotificationValidationError("INVALID_TARGET_PATH", "通知目标必须是站内相对路径。");
  }
  return value;
}

export function stableText(value: unknown, field: string, maximum = 191): string {
  if (typeof value !== "string") {
    throw new NotificationValidationError("INVALID_NOTIFICATION", `${field} 必须是字符串。`);
  }
  const text = value.trim();
  if (!text || text.length > maximum) {
    throw new NotificationValidationError(
      "INVALID_NOTIFICATION",
      `${field} 必须是 1 到 ${maximum} 个字符。`
    );
  }
  return text;
}
