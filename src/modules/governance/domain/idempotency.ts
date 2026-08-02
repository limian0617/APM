import { createHash } from "node:crypto";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class InvalidEventPayloadError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function normalize(value: unknown, seen: Set<object>): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidEventPayloadError("事件负载不能包含非有限数字。");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new InvalidEventPayloadError("事件负载必须是可序列化 JSON。");
  }
  if (seen.has(value)) {
    throw new InvalidEventPayloadError("事件负载不能包含循环引用。");
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalize(item, seen));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new InvalidEventPayloadError("事件负载只能包含普通 JSON 对象。");
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize((value as Record<string, unknown>)[key], seen)])
    );
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): { value: JsonValue; serialized: string } {
  const normalized = normalize(value, new Set());
  return { value: normalized, serialized: JSON.stringify(normalized) };
}

export function payloadHash(value: unknown): { value: JsonValue; hash: string } {
  const canonical = canonicalJson(value);
  return {
    value: canonical.value,
    hash: createHash("sha256").update(canonical.serialized).digest("hex")
  };
}
