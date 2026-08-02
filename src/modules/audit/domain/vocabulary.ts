export const AUDIT_ACTIONS = {
  AUTHORIZATION_DENIED: "AUTHORIZATION_DENIED",
  PROJECT_MEMBER_ADDED: "PROJECT_MEMBER_ADDED",
  PROJECT_MEMBER_ENDED: "PROJECT_MEMBER_ENDED",
  AUDIT_LOG_READ: "AUDIT_LOG_READ"
} as const;

export const AUDIT_OBJECT_TYPES = {
  PROJECT: "PROJECT",
  PROJECT_MEMBER: "PROJECT_MEMBER",
  AUDIT_LOG: "AUDIT_LOG"
} as const;

export const AUDIT_SOURCES = {
  API: "API",
  WORKER: "WORKER",
  SCHEDULER: "SCHEDULER",
  SYSTEM: "SYSTEM",
  INTEGRATION: "INTEGRATION",
  EXTERNAL_API: "EXTERNAL_API"
} as const;

export const AUDIT_RESULTS = {
  SUCCESS: "SUCCESS",
  DENIED: "DENIED",
  FAILURE: "FAILURE"
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
export type AuditObjectType = (typeof AUDIT_OBJECT_TYPES)[keyof typeof AUDIT_OBJECT_TYPES];
export type AuditSource = (typeof AUDIT_SOURCES)[keyof typeof AUDIT_SOURCES];
export type AuditResult = (typeof AUDIT_RESULTS)[keyof typeof AUDIT_RESULTS];

export const AUDIT_ACTION_VALUES = Object.values(AUDIT_ACTIONS);
export const AUDIT_OBJECT_TYPE_VALUES = Object.values(AUDIT_OBJECT_TYPES);

export const PROJECT_MEMBER_AUDIT_FIELDS = [
  "projectId",
  "userId",
  "projectRole",
  "departmentId",
  "leftAt",
  "version"
] as const;

export const AUTHORIZATION_DENIAL_AUDIT_FIELDS = ["permission", "method", "path"] as const;

export const AUDIT_QUERY_FIELDS = [
  "objectType",
  "objectId",
  "actorId",
  "action",
  "projectId",
  "departmentId",
  "from",
  "to",
  "limit",
  "returnedCount"
] as const;
