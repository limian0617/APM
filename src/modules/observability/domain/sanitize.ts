const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const SENSITIVE_KEY =
  /(^|[_-])(pass(word)?|secret|token|authorization|cookie|otp|salary|wage|payroll|share.?code|signature|private.?key|api.?key|file.?content|raw.?file|binary|attachment)([_-]|$)/iu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu;
const URI_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/giu;
const SENSITIVE_QUERY =
  /([?&](?:access_token|api_key|password|secret|signature|token)=)[^&#\s]+/giu;

function safeString(value: string, maximum = 2048): string {
  const redacted = value
    .replace(PRIVATE_KEY, REDACTED)
    .replace(URI_CREDENTIALS, `$1${REDACTED}@`)
    .replace(SENSITIVE_QUERY, `$1${REDACTED}`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  return redacted.length <= maximum ? redacted : `${redacted.slice(0, maximum)}${TRUNCATED}`;
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return safeString(value);
  if (typeof value !== "object") return safeString(String(value));
  if (depth >= 8) return TRUNCATED;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: safeString(value.name, 191),
      message: safeString(value.message),
      stack: value.stack ? safeString(value.stack, 4096) : null
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitize(item, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(item, depth + 1, seen);
  }
  return result;
}

export function sanitizeTelemetry(value: unknown): unknown {
  try {
    return sanitize(value, 0, new WeakSet<object>());
  } catch {
    return "[UNSERIALIZABLE]";
  }
}

export function sanitizeLogFields(
  fields: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const sanitized = sanitizeTelemetry(fields);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : { telemetry_value: sanitized };
}
