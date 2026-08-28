import { createHash, randomUUID } from "node:crypto";

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const TRACE_ID = /^[0-9a-f]{32}$/u;
const ZERO_TRACE_ID = "00000000000000000000000000000000";

export function normalizeRequestId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && REQUEST_ID.test(normalized) ? normalized : null;
}

export function normalizeTraceId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized !== ZERO_TRACE_ID && TRACE_ID.test(normalized)
    ? normalized
    : null;
}

export function traceIdFromTraceparent(value: string | null | undefined): string | null {
  const match = value?.trim().match(/^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/iu);
  return normalizeTraceId(match?.[1]);
}

export function traceIdFromSeed(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

export function createCorrelationIds(
  headers: Headers,
  createId: () => string = randomUUID
): { requestId: string; traceId: string } {
  const requestId = normalizeRequestId(headers.get("x-request-id")) ?? createId();
  const traceId =
    traceIdFromTraceparent(headers.get("traceparent")) ??
    normalizeTraceId(headers.get("x-trace-id")) ??
    traceIdFromSeed(createId());
  return { requestId, traceId };
}
