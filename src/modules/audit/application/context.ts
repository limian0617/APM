import { randomUUID } from "node:crypto";

import type { AuditContext } from "../contracts/audit";
import { sanitizeAuditText } from "../domain/sanitize";
import { AUDIT_SOURCES, type AuditSource } from "../domain/vocabulary";

type AuditContextInput = {
  actorId: string | null;
  source?: AuditSource;
  reason?: string | null;
  projectId?: string | null;
  departmentId?: string | null;
  operationId?: string | null;
};

function headerValue(request: Request, name: string, maximumLength = 191): string | null {
  const value = request.headers.get(name)?.trim();
  return value ? sanitizeAuditText(value, maximumLength) : null;
}

function traceId(request: Request): string | null {
  const explicit = headerValue(request, "x-trace-id");
  if (explicit) {
    return explicit;
  }

  const traceparent = request.headers.get("traceparent")?.trim();
  const match = traceparent?.match(/^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i);
  return match?.[1] ?? null;
}

export function auditContextFromRequest(
  request: Request,
  input: AuditContextInput,
  createId: () => string = randomUUID
): AuditContext {
  const requestId = headerValue(request, "x-request-id") ?? createId();
  const forwardedIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const operationId =
    input.operationId?.trim() ||
    headerValue(request, "idempotency-key") ||
    headerValue(request, "x-operation-id") ||
    requestId;

  return {
    actorId: input.actorId,
    requestId,
    traceId: traceId(request),
    source: input.source ?? AUDIT_SOURCES.API,
    sourceIp:
      sanitizeAuditText(forwardedIp || headerValue(request, "x-real-ip") || "", 191) || null,
    userAgent: headerValue(request, "user-agent", 512),
    reason: sanitizeAuditText(input.reason ?? headerValue(request, "x-apm-reason") ?? "") || null,
    projectId: input.projectId ?? null,
    departmentId: input.departmentId ?? null,
    operationId: sanitizeAuditText(operationId, 191) || null
  };
}
