export const AUDIT_ACTIONS = {
  AUTHORIZATION_DENIED: "AUTHORIZATION_DENIED",
  PROJECT_MEMBER_ADDED: "PROJECT_MEMBER_ADDED",
  PROJECT_MEMBER_ENDED: "PROJECT_MEMBER_ENDED",
  AUDIT_LOG_READ: "AUDIT_LOG_READ",
  CONFIGURATION_SETTING_CHANGED: "CONFIGURATION_SETTING_CHANGED",
  COMPANY_CAPABILITY_CHANGED: "COMPANY_CAPABILITY_CHANGED",
  JOB_REPLAYED: "JOB_REPLAYED",
  FILE_UPLOAD_STARTED: "FILE_UPLOAD_STARTED",
  FILE_UPLOAD_COMPLETED: "FILE_UPLOAD_COMPLETED",
  FILE_SCAN_COMPLETED: "FILE_SCAN_COMPLETED",
  FILE_QUARANTINED: "FILE_QUARANTINED",
  FILE_PROCESSING_FAILED: "FILE_PROCESSING_FAILED",
  FILE_DOWNLOAD_URL_ISSUED: "FILE_DOWNLOAD_URL_ISSUED",
  NOTIFICATION_TEMPLATE_PUBLISHED: "NOTIFICATION_TEMPLATE_PUBLISHED",
  NOTIFICATION_TEMPLATE_STATUS_CHANGED: "NOTIFICATION_TEMPLATE_STATUS_CHANGED",
  NOTIFICATION_CREATED: "NOTIFICATION_CREATED",
  NOTIFICATION_INBOX_READ: "NOTIFICATION_INBOX_READ",
  NOTIFICATION_MARKED_READ: "NOTIFICATION_MARKED_READ",
  NOTIFICATION_DELIVERED: "NOTIFICATION_DELIVERED",
  TEMPLATE_COMPONENT_DRAFT_SAVED: "TEMPLATE_COMPONENT_DRAFT_SAVED",
  TEMPLATE_COMPONENT_PUBLISHED: "TEMPLATE_COMPONENT_PUBLISHED",
  TEMPLATE_COMPONENT_STATUS_CHANGED: "TEMPLATE_COMPONENT_STATUS_CHANGED",
  TEMPLATE_DRAFT_SAVED: "TEMPLATE_DRAFT_SAVED",
  TEMPLATE_PUBLISHED: "TEMPLATE_PUBLISHED",
  TEMPLATE_STATUS_CHANGED: "TEMPLATE_STATUS_CHANGED",
  PROJECT_CREATED: "PROJECT_CREATED",
  PROJECT_STRUCTURE_INITIALIZED: "PROJECT_STRUCTURE_INITIALIZED",
  DELIVERY_UNIT_STATUS_CHANGED: "DELIVERY_UNIT_STATUS_CHANGED",
  PROJECT_CAPABILITIES_CONFIRMED: "PROJECT_CAPABILITIES_CONFIRMED",
  PROJECT_CAPABILITY_CHANGED: "PROJECT_CAPABILITY_CHANGED",
  RESPONSIBILITY_PACKAGE_CREATED: "RESPONSIBILITY_PACKAGE_CREATED",
  RESPONSIBILITY_PACKAGE_UPDATED: "RESPONSIBILITY_PACKAGE_UPDATED",
  RESPONSIBILITY_PACKAGE_ACCEPTANCE_SUBMITTED: "RESPONSIBILITY_PACKAGE_ACCEPTANCE_SUBMITTED",
  RESPONSIBILITY_PACKAGE_ACCEPTED: "RESPONSIBILITY_PACKAGE_ACCEPTED",
  RESPONSIBILITY_PACKAGE_REOPENED: "RESPONSIBILITY_PACKAGE_REOPENED",
  RESPONSIBILITY_PACKAGE_CLOSED: "RESPONSIBILITY_PACKAGE_CLOSED",
  WBS_NODE_CREATED: "WBS_NODE_CREATED",
  WBS_NODE_UPDATED: "WBS_NODE_UPDATED",
  WBS_NODE_CLOSED: "WBS_NODE_CLOSED",
  PLANNING_TASK_CREATED: "PLANNING_TASK_CREATED",
  PLANNING_TASK_UPDATED: "PLANNING_TASK_UPDATED",
  PLANNING_TASK_PROGRESS_UPDATED: "PLANNING_TASK_PROGRESS_UPDATED",
  PLANNING_TASK_CLOSED: "PLANNING_TASK_CLOSED"
} as const;

export const AUDIT_OBJECT_TYPES = {
  PROJECT: "PROJECT",
  PROJECT_MEMBER: "PROJECT_MEMBER",
  AUDIT_LOG: "AUDIT_LOG",
  SYSTEM_SETTING: "SYSTEM_SETTING",
  COMPANY_CAPABILITY: "COMPANY_CAPABILITY",
  OUTBOX_EVENT: "OUTBOX_EVENT",
  PERSISTENT_JOB: "PERSISTENT_JOB",
  FILE_OBJECT: "FILE_OBJECT",
  FILE_UPLOAD_SESSION: "FILE_UPLOAD_SESSION",
  NOTIFICATION_TEMPLATE: "NOTIFICATION_TEMPLATE",
  NOTIFICATION: "NOTIFICATION",
  NOTIFICATION_DELIVERY: "NOTIFICATION_DELIVERY",
  TEMPLATE_COMPONENT: "TEMPLATE_COMPONENT",
  TEMPLATE: "TEMPLATE",
  TEMPLATE_VERSION: "TEMPLATE_VERSION",
  DELIVERY_UNIT: "DELIVERY_UNIT",
  PROJECT_MODULE: "PROJECT_MODULE",
  PROJECT_CAPABILITY: "PROJECT_CAPABILITY",
  RESPONSIBILITY_PACKAGE: "RESPONSIBILITY_PACKAGE",
  WBS_NODE: "WBS_NODE",
  PLANNING_TASK: "PLANNING_TASK"
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

export const SYSTEM_SETTING_AUDIT_FIELDS = ["key", "value", "valueType", "version"] as const;

export const COMPANY_CAPABILITY_AUDIT_FIELDS = ["code", "enabled", "version"] as const;

export const JOB_REPLAY_AUDIT_FIELDS = ["jobId", "jobType", "attemptNumber", "reason"] as const;

export const FILE_AUDIT_FIELDS = [
  "fileId",
  "sessionId",
  "projectId",
  "status",
  "sensitivity",
  "mimeType",
  "size",
  "sha256",
  "scanEngine",
  "scannerVersion",
  "scanSignature",
  "failureCode",
  "permission",
  "method",
  "path",
  "expiresInSeconds"
] as const;

export const NOTIFICATION_AUDIT_FIELDS = [
  "notificationId",
  "deliveryId",
  "templateCode",
  "templateVersion",
  "sourceEventKey",
  "eventType",
  "recipientId",
  "projectId",
  "sensitivity",
  "channel",
  "status",
  "attemptNumber",
  "enabled",
  "version",
  "returnedCount",
  "unreadOnly",
  "permission",
  "method",
  "path"
] as const;

export const TEMPLATE_AUDIT_FIELDS = [
  "templateId",
  "templateCode",
  "templateVersionId",
  "templateVersion",
  "componentId",
  "componentCode",
  "componentVersionId",
  "componentVersion",
  "componentType",
  "name",
  "status",
  "version",
  "checksum",
  "referenceCount",
  "enabled"
] as const;

export const PROJECT_CREATION_AUDIT_FIELDS = [
  "projectId",
  "projectCode",
  "projectName",
  "departmentId",
  "status",
  "initializationStatus",
  "sourceTemplateVersionId",
  "sourceTemplateChecksum",
  "snapshotId",
  "snapshotChecksum",
  "referenceCount",
  "version"
] as const;

export const PROJECT_STRUCTURE_AUDIT_FIELDS = [
  "projectType",
  "equipmentShape",
  "structureStatus",
  "structureChecksum",
  "deliveryUnitCount",
  "moduleCount",
  "version"
] as const;

export const DELIVERY_UNIT_AUDIT_FIELDS = [
  "projectId",
  "deliveryUnitId",
  "code",
  "status",
  "version"
] as const;

export const PROJECT_CAPABILITIES_AUDIT_FIELDS = [
  "projectId",
  "configurationStatus",
  "capabilitiesConfiguredAt",
  "capabilities",
  "version"
] as const;

export const PROJECT_CAPABILITY_AUDIT_FIELDS = [
  "projectId",
  "capabilityCode",
  "templateAllowed",
  "templateRequired",
  "selectedEnabled",
  "companyEnabled",
  "companyVersion",
  "effectiveEnabled",
  "version"
] as const;

export const RESPONSIBILITY_PACKAGE_AUDIT_FIELDS = [
  "projectId",
  "packageId",
  "code",
  "name",
  "deliveryUnitId",
  "moduleId",
  "ownerMembershipId",
  "inputCount",
  "outputCount",
  "acceptanceCriteriaCount",
  "valueWeight",
  "status",
  "acceptanceCycle",
  "transitionSequence",
  "version"
] as const;

export const WBS_NODE_AUDIT_FIELDS = [
  "projectId",
  "nodeId",
  "parentId",
  "code",
  "name",
  "position",
  "status",
  "version"
] as const;

export const PLANNING_TASK_AUDIT_FIELDS = [
  "projectId",
  "taskId",
  "wbsNodeId",
  "responsibilityPackageId",
  "deliveryUnitId",
  "moduleId",
  "ownerMembershipId",
  "code",
  "name",
  "position",
  "plannedStartAt",
  "plannedFinishAt",
  "plannedDurationMinutes",
  "weight",
  "status",
  "actualStartAt",
  "actualFinishAt",
  "remainingDurationMinutes",
  "forecastFinishAt",
  "version"
] as const;

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
