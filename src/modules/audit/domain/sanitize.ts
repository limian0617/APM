export type SanitizedAuditValue =
  null | boolean | number | string | SanitizedAuditValue[] | { [key: string]: SanitizedAuditValue };

export class AuditSerializationError extends Error {
  constructor(
    readonly path: string,
    readonly reason: "CIRCULAR_REFERENCE" | "UNSUPPORTED_VALUE",
    message: string
  ) {
    super(message);
    this.name = "AuditSerializationError";
  }
}

const SENSITIVE_KEY_PARTS = [
  "password",
  "passwd",
  "onetimepassword",
  "otp",
  "secret",
  "token",
  "authorization",
  "cookie",
  "apikey",
  "accesskey",
  "privatekey",
  "encryptionkey",
  "credential",
  "sessionid",
  "sessiontoken",
  "refreshtoken",
  "actualwage",
  "actualsalary",
  "actualpay",
  "salary",
  "wage",
  "payroll",
  "compensation",
  "signedurl",
  "fileurl",
  "downloadurl",
  "sharecode"
];

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveAuditKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part)) ||
    /(密码|口令|令牌|密钥|工资|薪资)/.test(key)
  );
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^file:/i.test(value);
}

export function sanitizeAuditText(value: string, maximumLength = 1024): string {
  const redacted = value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(authorization|cookie|password|passwd|otp|secret|token|actual[_ -]?salary|actual[_ -]?wage|salary|wage)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]"
    )
    .replace(/\b(?:https?|file):\/\/[^\s]+/gi, "[REDACTED_URL]")
    .trim();

  return redacted.slice(0, maximumLength);
}

export function sanitizeAuditValue(
  value: unknown,
  allowedFields: readonly string[]
): SanitizedAuditValue {
  const allowed = new Set(allowedFields);
  const ancestors = new Set<object>();

  function visit(current: unknown, path: string): SanitizedAuditValue {
    if (current === null) {
      return null;
    }
    if (typeof current === "string") {
      return isAbsoluteUrl(current) ? "[REDACTED_URL]" : sanitizeAuditText(current);
    }
    if (typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new AuditSerializationError(
          path,
          "UNSUPPORTED_VALUE",
          `审计字段 ${path} 包含非有限数值。`
        );
      }
      return current;
    }
    if (current instanceof Date) {
      if (Number.isNaN(current.getTime())) {
        throw new AuditSerializationError(
          path,
          "UNSUPPORTED_VALUE",
          `审计字段 ${path} 包含无效日期。`
        );
      }
      return current.toISOString();
    }
    if (typeof current !== "object") {
      throw new AuditSerializationError(
        path,
        "UNSUPPORTED_VALUE",
        `审计字段 ${path} 包含不支持的 ${typeof current} 值。`
      );
    }
    if (ancestors.has(current)) {
      throw new AuditSerializationError(
        path,
        "CIRCULAR_REFERENCE",
        `审计字段 ${path} 包含循环引用。`
      );
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map((item, index) => visit(item, `${path}[${index}]`));
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new AuditSerializationError(
          path,
          "UNSUPPORTED_VALUE",
          `审计字段 ${path} 包含不支持的对象类型。`
        );
      }

      const result: { [key: string]: SanitizedAuditValue } = {};
      for (const [key, child] of Object.entries(current)) {
        if (!allowed.has(key) || isSensitiveAuditKey(key)) {
          continue;
        }
        result[key] = visit(child, `${path}.${key}`);
      }
      return result;
    } finally {
      ancestors.delete(current);
    }
  }

  return visit(value, "$");
}
