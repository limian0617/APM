import { Prisma } from "@prisma/client";

import type { AuditEvent, AuditPayload } from "../contracts/audit";
import { sanitizeAuditText, sanitizeAuditValue } from "../domain/sanitize";
import { AUDIT_RESULTS } from "../domain/vocabulary";

export type AuditWriteClient = Pick<Prisma.TransactionClient, "auditLog">;

function jsonPayload(
  payload: AuditPayload | undefined
): Prisma.InputJsonValue | Prisma.NullTypes.JsonNull | undefined {
  if (!payload) {
    return undefined;
  }
  const value = sanitizeAuditValue(payload.value, payload.allowedFields);
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

function column(value: string | null | undefined, maximumLength = 191): string | null {
  if (!value) {
    return null;
  }
  return sanitizeAuditText(value, maximumLength) || null;
}

export async function writeAudit(client: AuditWriteClient, event: AuditEvent) {
  const beforeJson = jsonPayload(event.before);
  const afterJson = jsonPayload(event.after);
  const metadataJson = jsonPayload(event.metadata);

  return client.auditLog.create({
    data: {
      actorId: column(event.context.actorId),
      action: event.action,
      objectType: event.objectType,
      objectId: column(event.objectId),
      projectId: column(event.context.projectId),
      departmentId: column(event.context.departmentId),
      requestId: column(event.context.requestId),
      traceId: column(event.context.traceId),
      operationId: column(event.context.operationId),
      ...(beforeJson === undefined ? {} : { beforeJson }),
      ...(afterJson === undefined ? {} : { afterJson }),
      ...(metadataJson === undefined ? {} : { metadataJson }),
      source: event.context.source,
      sourceIp: column(event.context.sourceIp),
      userAgent: column(event.context.userAgent, 512),
      reason: column(event.context.reason, 1024),
      result: event.result ?? AUDIT_RESULTS.SUCCESS
    }
  });
}
