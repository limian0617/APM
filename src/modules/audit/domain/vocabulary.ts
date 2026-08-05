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
  SENSITIVE_FILE_READ: "SENSITIVE_FILE_READ",
  CONTROLLED_DOCUMENT_CREATED: "CONTROLLED_DOCUMENT_CREATED",
  CONTROLLED_DOCUMENT_VERSION_DRAFTED: "CONTROLLED_DOCUMENT_VERSION_DRAFTED",
  CONTROLLED_DOCUMENT_VERSION_PUBLISHED: "CONTROLLED_DOCUMENT_VERSION_PUBLISHED",
  CONTROLLED_DOCUMENT_VOIDED: "CONTROLLED_DOCUMENT_VOIDED",
  PUBLIC_LIBRARY_DOCUMENT_CREATED: "PUBLIC_LIBRARY_DOCUMENT_CREATED",
  PUBLIC_LIBRARY_VERSION_DRAFTED: "PUBLIC_LIBRARY_VERSION_DRAFTED",
  PUBLIC_LIBRARY_VERSION_PUBLISHED: "PUBLIC_LIBRARY_VERSION_PUBLISHED",
  PUBLIC_LIBRARY_DOCUMENT_VOIDED: "PUBLIC_LIBRARY_DOCUMENT_VOIDED",
  PROJECT_PUBLIC_LIBRARY_REFERENCE_CREATED: "PROJECT_PUBLIC_LIBRARY_REFERENCE_CREATED",
  PROJECT_PUBLIC_LIBRARY_REFERENCE_RETIRED: "PROJECT_PUBLIC_LIBRARY_REFERENCE_RETIRED",
  DOCUMENT_REVIEW_REQUESTED: "DOCUMENT_REVIEW_REQUESTED",
  DOCUMENT_REVIEW_DECIDED: "DOCUMENT_REVIEW_DECIDED",
  DOCUMENT_REVIEW_COMMENTED: "DOCUMENT_REVIEW_COMMENTED",
  DOCUMENT_REVIEW_COMMENT_RESOLVED: "DOCUMENT_REVIEW_COMMENT_RESOLVED",
  DOCUMENT_VERSION_RELATED: "DOCUMENT_VERSION_RELATED",
  DOCUMENT_VERSION_RELATION_VOIDED: "DOCUMENT_VERSION_RELATION_VOIDED",
  MECHANICAL_DRAWING_CREATED: "MECHANICAL_DRAWING_CREATED",
  MECHANICAL_DRAWING_VERSION_DRAFTED: "MECHANICAL_DRAWING_VERSION_DRAFTED",
  MECHANICAL_DRAWING_VERSION_PUBLISHED: "MECHANICAL_DRAWING_VERSION_PUBLISHED",
  MECHANICAL_DRAWING_IMPORT_CREATED: "MECHANICAL_DRAWING_IMPORT_CREATED",
  MECHANICAL_DRAWING_IMPORT_CONFIRMED: "MECHANICAL_DRAWING_IMPORT_CONFIRMED",
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
  PLANNING_TASK_CLOSED: "PLANNING_TASK_CLOSED",
  PROJECT_CALENDAR_CREATED: "PROJECT_CALENDAR_CREATED",
  PROJECT_CALENDAR_UPDATED: "PROJECT_CALENDAR_UPDATED",
  PROJECT_CALENDAR_CLOSED: "PROJECT_CALENDAR_CLOSED",
  TASK_DEPENDENCY_CREATED: "TASK_DEPENDENCY_CREATED",
  TASK_DEPENDENCY_UPDATED: "TASK_DEPENDENCY_UPDATED",
  TASK_DEPENDENCY_CLOSED: "TASK_DEPENDENCY_CLOSED",
  PLANNING_BASELINE_FROZEN: "PLANNING_BASELINE_FROZEN",
  PROJECT_MILESTONE_CREATED: "PROJECT_MILESTONE_CREATED",
  PROJECT_MILESTONE_UPDATED: "PROJECT_MILESTONE_UPDATED",
  PROJECT_MILESTONE_TASK_LINKED: "PROJECT_MILESTONE_TASK_LINKED",
  PROJECT_MILESTONE_TASK_LINK_VOIDED: "PROJECT_MILESTONE_TASK_LINK_VOIDED",
  PROJECT_MILESTONE_ACHIEVED_MANUALLY: "PROJECT_MILESTONE_ACHIEVED_MANUALLY",
  PROJECT_MILESTONE_ACHIEVED_FROM_LINKED_TASKS: "PROJECT_MILESTONE_ACHIEVED_FROM_LINKED_TASKS",
  PROJECT_MILESTONE_VOIDED: "PROJECT_MILESTONE_VOIDED",
  PROJECT_STAGE_CREATED: "PROJECT_STAGE_CREATED",
  PROJECT_STAGE_UPDATED: "PROJECT_STAGE_UPDATED",
  DELIVERY_UNIT_STAGE_UPDATED: "DELIVERY_UNIT_STAGE_UPDATED",
  STAGE_RELEASE_AUTHORIZED: "STAGE_RELEASE_AUTHORIZED",
  STAGE_RELEASE_REVOKED: "STAGE_RELEASE_REVOKED",
  GATE_DEFINITION_MATERIALIZED: "GATE_DEFINITION_MATERIALIZED",
  GATE_INSTANCE_CREATED: "GATE_INSTANCE_CREATED",
  GATE_CHECK_RUN_COMPLETED: "GATE_CHECK_RUN_COMPLETED",
  GATE_SUBMISSION_SUBMITTED: "GATE_SUBMISSION_SUBMITTED",
  GATE_APPROVAL_RECORDED: "GATE_APPROVAL_RECORDED",
  GATE_SUBMISSION_WITHDRAWN: "GATE_SUBMISSION_WITHDRAWN",
  GATE_SUBMISSION_APPROVED: "GATE_SUBMISSION_APPROVED",
  GATE_SUBMISSION_REJECTED: "GATE_SUBMISSION_REJECTED",
  GATE_CONDITIONALLY_RELEASED: "GATE_CONDITIONALLY_RELEASED",
  RESIDUAL_ITEM_CREATED: "RESIDUAL_ITEM_CREATED",
  RESIDUAL_ITEM_STARTED: "RESIDUAL_ITEM_STARTED",
  RESIDUAL_ITEM_VERIFICATION_SUBMITTED: "RESIDUAL_ITEM_VERIFICATION_SUBMITTED",
  RESIDUAL_ITEM_VERIFIED: "RESIDUAL_ITEM_VERIFIED",
  RESIDUAL_ITEM_RETURNED: "RESIDUAL_ITEM_RETURNED",
  ALERT_RULE_CREATED: "ALERT_RULE_CREATED",
  ALERT_RULE_UPDATED: "ALERT_RULE_UPDATED",
  ALERT_SCAN_REQUESTED: "ALERT_SCAN_REQUESTED",
  ALERT_SCAN_COMPLETED: "ALERT_SCAN_COMPLETED",
  ALERT_TRIGGERED: "ALERT_TRIGGERED",
  ALERT_ACKNOWLEDGED: "ALERT_ACKNOWLEDGED",
  ALERT_STARTED: "ALERT_STARTED",
  ALERT_RESOLVED: "ALERT_RESOLVED",
  ALERT_CLOSED: "ALERT_CLOSED",
  ALERT_ESCALATED: "ALERT_ESCALATED",
  RND_PROJECT_CREATED: "RND_PROJECT_CREATED",
  RND_PROJECT_STATUS_CHANGED: "RND_PROJECT_STATUS_CHANGED",
  TECHNICAL_ASSET_CREATED: "TECHNICAL_ASSET_CREATED",
  TECHNICAL_ASSET_STATUS_CHANGED: "TECHNICAL_ASSET_STATUS_CHANGED",
  TECHNICAL_ASSET_VALIDATED: "TECHNICAL_ASSET_VALIDATED",
  COCKPIT_PROJECTION_REFRESHED: "COCKPIT_PROJECTION_REFRESHED",
  COCKPIT_RESOURCE_LOAD_REFRESHED: "COCKPIT_RESOURCE_LOAD_REFRESHED",
  COCKPIT_RESOURCE_LOAD_PERSON_READ: "COCKPIT_RESOURCE_LOAD_PERSON_READ"
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
  CONTROLLED_DOCUMENT: "CONTROLLED_DOCUMENT",
  CONTROLLED_DOCUMENT_VERSION: "CONTROLLED_DOCUMENT_VERSION",
  PUBLIC_LIBRARY_DOCUMENT: "PUBLIC_LIBRARY_DOCUMENT",
  PUBLIC_LIBRARY_DOCUMENT_VERSION: "PUBLIC_LIBRARY_DOCUMENT_VERSION",
  PROJECT_PUBLIC_LIBRARY_REFERENCE: "PROJECT_PUBLIC_LIBRARY_REFERENCE",
  DOCUMENT_REVIEW: "DOCUMENT_REVIEW",
  DOCUMENT_REVIEW_COMMENT: "DOCUMENT_REVIEW_COMMENT",
  DOCUMENT_VERSION_RELATION: "DOCUMENT_VERSION_RELATION",
  GATE_SUBMISSION_DOCUMENT_REFERENCE: "GATE_SUBMISSION_DOCUMENT_REFERENCE",
  MECHANICAL_DRAWING: "MECHANICAL_DRAWING",
  MECHANICAL_DRAWING_VERSION_FILE: "MECHANICAL_DRAWING_VERSION_FILE",
  MECHANICAL_DRAWING_IMPORT_BATCH: "MECHANICAL_DRAWING_IMPORT_BATCH",
  MECHANICAL_DRAWING_IMPORT_ITEM: "MECHANICAL_DRAWING_IMPORT_ITEM",
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
  PLANNING_TASK: "PLANNING_TASK",
  PROJECT_CALENDAR: "PROJECT_CALENDAR",
  TASK_DEPENDENCY: "TASK_DEPENDENCY",
  PLANNING_BASELINE: "PLANNING_BASELINE",
  PROJECT_MILESTONE: "PROJECT_MILESTONE",
  PROJECT_STAGE: "PROJECT_STAGE",
  DELIVERY_UNIT_STAGE: "DELIVERY_UNIT_STAGE",
  STAGE_RELEASE_AUTHORIZATION: "STAGE_RELEASE_AUTHORIZATION",
  PROJECT_GATE_DEFINITION: "PROJECT_GATE_DEFINITION",
  PROJECT_GATE_INSTANCE: "PROJECT_GATE_INSTANCE",
  GATE_CHECK_SNAPSHOT: "GATE_CHECK_SNAPSHOT",
  GATE_SUBMISSION: "GATE_SUBMISSION",
  GATE_APPROVAL: "GATE_APPROVAL",
  GATE_CONDITIONAL_RELEASE: "GATE_CONDITIONAL_RELEASE",
  RESIDUAL_ITEM: "RESIDUAL_ITEM",
  ALERT_RULE: "ALERT_RULE",
  PROJECT_ALERT: "PROJECT_ALERT",
  PROJECT_ALERT_SCAN: "PROJECT_ALERT_SCAN",
  RND_PROJECT: "RND_PROJECT",
  RND_PROJECT_EVENT: "RND_PROJECT_EVENT",
  TECHNICAL_ASSET: "TECHNICAL_ASSET",
  TECHNICAL_ASSET_EVENT: "TECHNICAL_ASSET_EVENT",
  TECHNICAL_ASSET_VALIDATION: "TECHNICAL_ASSET_VALIDATION",
  COCKPIT_PROJECTION: "COCKPIT_PROJECTION",
  COCKPIT_RESOURCE_LOAD: "COCKPIT_RESOURCE_LOAD"
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

export const CONTROLLED_DOCUMENT_AUDIT_FIELDS = [
  "projectId",
  "documentId",
  "documentCode",
  "documentTitle",
  "documentStatus",
  "documentVersionId",
  "documentVersion",
  "documentVersionStatus",
  "sourceFileId",
  "sourceFileSha256",
  "sourceMimeType",
  "sourceFileSize",
  "currentPublishedVersionId",
  "version",
  "reason"
] as const;

export const PUBLIC_LIBRARY_AUDIT_FIELDS = [
  "projectId",
  "publicLibraryDocumentId",
  "publicDocumentVersionId",
  "projectPublicLibraryReferenceId",
  "documentCode",
  "documentTitle",
  "materialType",
  "documentStatus",
  "documentVersion",
  "documentVersionStatus",
  "sourceFileId",
  "sourceFileSha256",
  "sourceMimeType",
  "sourceFileSize",
  "applicableModels",
  "applicablePlatforms",
  "currentPublishedVersionId",
  "referenceStatus",
  "version",
  "reason"
] as const;

export const DOCUMENT_REVIEW_AUDIT_FIELDS = [
  "projectId",
  "documentId",
  "documentVersionId",
  "documentVersion",
  "reviewId",
  "reviewerId",
  "required",
  "status",
  "commentId",
  "resolutionId",
  "openRequiredCommentCount",
  "reason",
  "version"
] as const;

export const DOCUMENT_VERSION_RELATION_AUDIT_FIELDS = [
  "projectId",
  "documentId",
  "documentVersionId",
  "documentVersion",
  "relationId",
  "targetType",
  "targetId",
  "status",
  "voidReason",
  "version"
] as const;

export const MECHANICAL_DRAWING_AUDIT_FIELDS = [
  "projectId",
  "drawingId",
  "drawingNumber",
  "drawingType",
  "drawingVersion",
  "documentId",
  "documentVersionId",
  "documentVersion",
  "fileId",
  "fileRole",
  "fileSha256",
  "fileMimeType",
  "fileSize",
  "batchId",
  "batchStatus",
  "batchVersion",
  "itemId",
  "itemStatus",
  "pairingStatus",
  "reason"
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

export const ALERT_AUDIT_FIELDS = [
  "projectId",
  "alertRuleId",
  "alertId",
  "scanId",
  "code",
  "sourceType",
  "sourceKey",
  "status",
  "probability",
  "impact",
  "ownerMembershipId",
  "escalationMembershipId",
  "escalationAfterDays",
  "version",
  "eventType",
  "reason",
  "permission",
  "method",
  "path"
] as const;

export const RND_PROJECT_AUDIT_FIELDS = [
  "rndProjectId",
  "rndProjectCode",
  "name",
  "description",
  "departmentId",
  "ownerId",
  "status",
  "fromStatus",
  "toStatus",
  "eventId",
  "eventSequence",
  "version",
  "reason"
] as const;

export const TECHNICAL_ASSET_AUDIT_FIELDS = [
  "rndProjectId",
  "technicalAssetId",
  "assetNumber",
  "assetType",
  "name",
  "description",
  "ownerId",
  "status",
  "fromStatus",
  "toStatus",
  "eventId",
  "eventSequence",
  "validationId",
  "validationDecision",
  "validatorId",
  "evidence",
  "assetVersion",
  "version",
  "reason"
] as const;

export const COCKPIT_AUDIT_FIELDS = [
  "projectId",
  "projectionId",
  "sourceChecksum",
  "health",
  "calculatedAt",
  "exceptionCount",
  "reused"
] as const;

export const RESOURCE_LOAD_AUDIT_FIELDS = [
  "projectId",
  "projectionId",
  "sourceChecksum",
  "calculatedAt",
  "peopleCount",
  "activeTaskCount",
  "reused"
] as const;

export const RESOURCE_LOAD_PERSON_READ_AUDIT_FIELDS = [
  "projectId",
  "projectionId",
  "peopleCount",
  "permission"
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

export const PROJECT_CALENDAR_AUDIT_FIELDS = [
  "projectId",
  "calendarId",
  "revisionId",
  "name",
  "timeZone",
  "weeklyRuleCount",
  "exceptionCount",
  "checksum",
  "status",
  "version"
] as const;

export const TASK_DEPENDENCY_AUDIT_FIELDS = [
  "projectId",
  "dependencyId",
  "predecessorTaskId",
  "successorTaskId",
  "dependencyType",
  "lagMinutes",
  "status",
  "version"
] as const;

export const PLANNING_BASELINE_AUDIT_FIELDS = [
  "projectId",
  "planningBaselineId",
  "sourceGateSubmissionId",
  "version",
  "planningInputVersion",
  "reason",
  "checksum",
  "wbsSnapshotCount",
  "taskSnapshotCount",
  "dependencySnapshotCount",
  "milestoneSnapshotCount",
  "milestoneTaskLinkSnapshotCount",
  "calendarSourceCalendarId",
  "calendarSourceCalendarRevisionId"
] as const;

export const PROJECT_MILESTONE_AUDIT_FIELDS = [
  "projectId",
  "milestoneId",
  "code",
  "name",
  "description",
  "position",
  "targetAt",
  "status",
  "achievementSource",
  "achievedAt",
  "voidedAt",
  "sourceSnapshotComponentId",
  "taskLinkId",
  "taskId",
  "taskLinkStatus",
  "voidReason",
  "version"
] as const;

export const PROJECT_STAGE_AUDIT_FIELDS = [
  "projectId",
  "projectStageId",
  "sourceSnapshotComponentId",
  "code",
  "name",
  "description",
  "sequence",
  "status",
  "exceptionalReason",
  "statusChangedAt",
  "version"
] as const;

export const DELIVERY_UNIT_STAGE_AUDIT_FIELDS = [
  "projectId",
  "deliveryUnitStageId",
  "deliveryUnitId",
  "projectStageId",
  "status",
  "exceptionalReason",
  "statusChangedAt",
  "version"
] as const;

export const STAGE_RELEASE_AUTHORIZATION_AUDIT_FIELDS = [
  "projectId",
  "stageReleaseAuthorizationId",
  "scope",
  "status",
  "fromProjectStageId",
  "toProjectStageId",
  "deliveryUnitId",
  "reason",
  "authorizedById",
  "authorizedAt",
  "revokedById",
  "revokedAt",
  "revocationReason",
  "version"
] as const;

export const PROJECT_GATE_DEFINITION_AUDIT_FIELDS = [
  "projectId",
  "gateDefinitionId",
  "sourceSnapshotComponentId",
  "projectStageId",
  "code",
  "scope",
  "definitionChecksum"
] as const;

export const PROJECT_GATE_INSTANCE_AUDIT_FIELDS = [
  "projectId",
  "gateInstanceId",
  "gateDefinitionId",
  "projectStageId",
  "scope",
  "deliveryUnitId",
  "moduleId",
  "version"
] as const;

export const GATE_CHECK_SNAPSHOT_AUDIT_FIELDS = [
  "projectId",
  "gateInstanceId",
  "gateCheckSnapshotId",
  "sequence",
  "status",
  "inputChecksum",
  "resultChecksum"
] as const;

export const GATE_SUBMISSION_AUDIT_FIELDS = [
  "projectId",
  "gateSubmissionId",
  "gateInstanceId",
  "gateCheckSnapshotId",
  "previousSubmissionId",
  "sequence",
  "status",
  "approvalMode",
  "approverProjectRoles",
  "approverUserIds",
  "submittedById",
  "submittedAt",
  "withdrawnById",
  "withdrawnAt",
  "withdrawalReason",
  "decidedAt",
  "documentReferences",
  "version"
] as const;

export const GATE_APPROVAL_AUDIT_FIELDS = [
  "projectId",
  "gateSubmissionId",
  "gateApprovalId",
  "gateSubmissionApproverId",
  "decision",
  "decidedById",
  "decidedAt",
  "status",
  "version"
] as const;

export const GATE_CONDITIONAL_RELEASE_AUDIT_FIELDS = [
  "projectId",
  "gateConditionalReleaseId",
  "gateSubmissionId",
  "gateInstanceId",
  "projectStageId",
  "deliveryUnitStageId",
  "releaseReason",
  "releasedById",
  "releasedAt",
  "version"
] as const;

export const RESIDUAL_ITEM_AUDIT_FIELDS = [
  "projectId",
  "residualItemId",
  "conditionalReleaseId",
  "sequence",
  "title",
  "ownerMembershipId",
  "verifierMembershipId",
  "dueAt",
  "evidence",
  "escalationRule",
  "status",
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
