import type { AuditAction, AuditObjectType, AuditResult, AuditSource } from "../domain/vocabulary";

export type AuditContext = {
  actorId: string | null;
  requestId: string | null;
  traceId: string | null;
  source: AuditSource;
  sourceIp: string | null;
  userAgent: string | null;
  reason: string | null;
  projectId: string | null;
  departmentId: string | null;
  operationId: string | null;
};

export type AuditPayload = {
  value: unknown;
  allowedFields: readonly string[];
};

export type AuditEvent = {
  action: AuditAction;
  objectType: AuditObjectType;
  objectId?: string | null;
  result?: AuditResult;
  context: AuditContext;
  before?: AuditPayload;
  after?: AuditPayload;
  metadata?: AuditPayload;
};
