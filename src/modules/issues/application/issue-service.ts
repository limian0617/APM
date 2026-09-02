import { IssueSourceType, Prisma, UserStatus } from "@prisma/client";

import { decideAuthorization, type AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  ISSUE_CAPTURE_AUDIT_FIELDS,
  ISSUE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  ISSUE_CATEGORIES,
  ISSUE_SEVERITIES,
  deriveIssueIndicators,
  IssueLifecycleError,
  nextIssueStatus,
  normalizeIssueTags,
  requiresIndependentVerification,
  type IssueAction,
  type IssueCategory,
  type IssueSeverity,
  type IssueStatus
} from "../domain/issue-lifecycle";

const issueInclude = {
  tags: { orderBy: { tag: "asc" } },
  history: { orderBy: { sequence: "asc" } },
  ownerMembership: { include: { user: true } },
  verifierMembership: { include: { user: true } },
  relations: {
    orderBy: { createdAt: "asc" },
    include: { blockerIssue: { select: { status: true } } }
  }
} satisfies Prisma.IssueInclude;

const issueCaptureFileSelect = {
  id: true,
  projectId: true,
  uploadedById: true,
  originalName: true,
  declaredMimeType: true,
  verifiedMimeType: true,
  sha256: true,
  status: true,
  sensitivity: true
} satisfies Prisma.FileObjectSelect;

const issueCaptureInclude = {
  voiceFile: { select: issueCaptureFileSelect },
  attachments: {
    orderBy: { fileId: "asc" },
    include: { file: { select: issueCaptureFileSelect } }
  }
} satisfies Prisma.IssueCaptureInclude;

type IssueFact = Prisma.IssueGetPayload<{ include: typeof issueInclude }>;
type IssueCaptureFact = Prisma.IssueCaptureGetPayload<{ include: typeof issueCaptureInclude }>;
type IssueCaptureFileFact = Prisma.FileObjectGetPayload<{ select: typeof issueCaptureFileSelect }>;
type IssueRelationFact = Prisma.IssueRelationGetPayload<{
  include: { blockerIssue: { select: { status: true } } };
}>;
type IssueEventType =
  | "CREATED"
  | "DETAILS_UPDATED"
  | "RESPONSIBILITY_ASSIGNED"
  | "RELATION_ADDED"
  | "RELATION_CLOSED"
  | "STARTED_ANALYSIS"
  | "STARTED_PROCESSING"
  | "VERIFICATION_SUBMITTED"
  | "CLOSED"
  | "REOPENED";

export class IssueServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export type IssueCaptureFileAccess = {
  actor: AuthorizationActor;
  projectDepartmentId: string | null;
  memberRoles: string[];
};

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new IssueServiceError(
      "ISSUE_INVALID_INPUT",
      `${field} 必须是 1 到 ${maximum} 个字符。`,
      422
    );
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  return requiredText(value, field, maximum);
}

function optionalCaptureText(value: unknown): string | null {
  return value === undefined || value === null ? null : requiredText(value, "inputText", 10_000);
}

function optionalIdentifier(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : requiredText(value, field, 191);
}

function captureMediaFileIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new IssueServiceError(
      "ISSUE_CAPTURE_INVALID_INPUT",
      "mediaFileIds 必须是不超过 20 项的数组。",
      422
    );
  }
  const ids = value.map((item) => requiredText(item, "mediaFileIds", 191));
  if (new Set(ids).size !== ids.length) {
    throw new IssueServiceError("ISSUE_CAPTURE_INVALID_INPUT", "mediaFileIds 不得重复。", 422);
  }
  return ids;
}

function category(value: unknown): IssueCategory {
  if (!ISSUE_CATEGORIES.includes(value as IssueCategory)) {
    throw new IssueServiceError(
      "ISSUE_INVALID_INPUT",
      "category 必须是预定义的问题一级分类。",
      422
    );
  }
  return value as IssueCategory;
}

function severity(value: unknown): IssueSeverity {
  if (!ISSUE_SEVERITIES.includes(value as IssueSeverity)) {
    throw new IssueServiceError("ISSUE_INVALID_INPUT", "severity 必须是预定义的问题严重度。", 422);
  }
  return value as IssueSeverity;
}

function sourceType(value: unknown): IssueSourceType {
  if (value === "PROJECT" || value === "FAT" || value === "SAT") return value;
  throw new IssueServiceError("ISSUE_INVALID_INPUT", "sourceType 未注册。", 422);
}

function rootCauseCategory(
  value: unknown
):
  | "DESIGN"
  | "MANUFACTURING"
  | "ASSEMBLY"
  | "SOFTWARE"
  | "PROCUREMENT"
  | "MATERIAL"
  | "PROCESS"
  | "OTHER"
  | null {
  if (value === undefined || value === null) return null;
  const values = [
    "DESIGN",
    "MANUFACTURING",
    "ASSEMBLY",
    "SOFTWARE",
    "PROCUREMENT",
    "MATERIAL",
    "PROCESS",
    "OTHER"
  ] as const;
  if (!values.includes(value as (typeof values)[number])) {
    throw new IssueServiceError("ISSUE_INVALID_INPUT", "rootCauseCategory 未注册。", 422);
  }
  return value as (typeof values)[number];
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new IssueServiceError("ISSUE_INVALID_INPUT", "version 必须是正整数。", 422);
  }
  return value as number;
}

function dueDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = requiredText(value, "dueDate", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) {
    throw new IssueServiceError("ISSUE_INVALID_INPUT", "dueDate 必须是 YYYY-MM-DD 格式。", 422);
  }
  return new Date(`${date}T00:00:00.000Z`);
}

function action(value: unknown): IssueAction {
  const values: IssueAction[] = [
    "START_ANALYSIS",
    "START_PROCESSING",
    "SUBMIT_VERIFICATION",
    "VERIFY_CLOSE",
    "REOPEN"
  ];
  if (!values.includes(value as IssueAction)) {
    throw new IssueServiceError("ISSUE_INVALID_INPUT", "action 不是受支持的问题状态动作。", 422);
  }
  return value as IssueAction;
}

function details(input: {
  title: unknown;
  confirmedText: unknown;
  category: unknown;
  severity: unknown;
  phenomenonDescription: unknown;
  rootCauseCategory: unknown;
  rootCauseDescription: unknown;
  tags: unknown;
}) {
  if (!Array.isArray(input.tags) || input.tags.length > 50) {
    throw new IssueServiceError("ISSUE_INVALID_INPUT", "tags 必须是不超过 50 项的数组。", 422);
  }
  const causeCategory = rootCauseCategory(input.rootCauseCategory);
  const causeDescription = optionalText(input.rootCauseDescription, "rootCauseDescription", 10_000);
  if ((causeCategory === null) !== (causeDescription === null)) {
    throw new IssueServiceError(
      "ISSUE_INVALID_INPUT",
      "根因分类和根因描述必须同时提供或同时留空。",
      422
    );
  }
  try {
    return {
      title: requiredText(input.title, "title", 191),
      confirmedText: requiredText(input.confirmedText, "confirmedText", 10_000),
      category: category(input.category),
      severity: severity(input.severity),
      phenomenonDescription: optionalText(
        input.phenomenonDescription,
        "phenomenonDescription",
        10_000
      ),
      rootCauseCategory: causeCategory,
      rootCauseDescription: causeDescription,
      tags: normalizeIssueTags(input.tags)
    };
  } catch (error) {
    if (error instanceof IssueLifecycleError) {
      throw new IssueServiceError("ISSUE_INVALID_INPUT", error.message, 422);
    }
    throw error;
  }
}

function serializeIssueRelation(relation: IssueRelationFact) {
  return {
    id: relation.id,
    projectId: relation.projectId,
    issueId: relation.issueId,
    relationType: relation.relationType,
    targetId: relation.targetId,
    status: relation.status,
    reason: relation.reason,
    closedReason: relation.closedReason,
    createdById: relation.createdById,
    closedById: relation.closedById,
    createdAt: relation.createdAt.toISOString(),
    closedAt: relation.closedAt?.toISOString() ?? null
  };
}

function serializeIssue(issue: IssueFact, now: Date) {
  const indicators = deriveIssueIndicators(
    {
      status: issue.status as IssueStatus,
      dueDate: issue.dueDate?.toISOString().slice(0, 10) ?? null,
      hasOpenBlocker: issue.relations.some(
        (relation) =>
          relation.status === "ACTIVE" &&
          relation.relationType === "BLOCKED_BY_ISSUE" &&
          relation.blockerIssue?.status !== "CLOSED"
      )
    },
    now
  );
  return {
    id: issue.id,
    projectId: issue.projectId,
    title: issue.title,
    confirmedText: issue.confirmedText,
    sourceType: issue.sourceType,
    category: issue.category,
    severity: issue.severity,
    phenomenonDescription: issue.phenomenonDescription,
    rootCauseCategory: issue.rootCauseCategory,
    rootCauseDescription: issue.rootCauseDescription,
    status: issue.status,
    statusChangedAt: issue.statusChangedAt.toISOString(),
    closedAt: issue.closedAt?.toISOString() ?? null,
    closedById: issue.closedById,
    verificationEvidence: issue.verificationEvidence,
    ownerMembershipId: issue.ownerMembershipId,
    verifierMembershipId: issue.verifierMembershipId,
    dueDate: issue.dueDate?.toISOString().slice(0, 10) ?? null,
    owner: issue.ownerMembership
      ? {
          membershipId: issue.ownerMembership.id,
          userId: issue.ownerMembership.userId,
          name: issue.ownerMembership.user.name,
          active:
            issue.ownerMembership.leftAt === null &&
            issue.ownerMembership.user.status === UserStatus.ACTIVE
        }
      : null,
    verifier: issue.verifierMembership
      ? {
          membershipId: issue.verifierMembership.id,
          userId: issue.verifierMembership.userId,
          name: issue.verifierMembership.user.name,
          active:
            issue.verifierMembership.leftAt === null &&
            issue.verifierMembership.user.status === UserStatus.ACTIVE
        }
      : null,
    requiresIndependentVerification: requiresIndependentVerification(
      issue.severity as IssueSeverity
    ),
    ...indicators,
    version: issue.version,
    createdById: issue.createdById,
    updatedById: issue.updatedById,
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
    tags: issue.tags.map((tag) => ({
      id: tag.id,
      tag: tag.tag,
      createdAt: tag.createdAt.toISOString()
    })),
    relations: issue.relations.map(serializeIssueRelation),
    history: issue.history.map((entry) => ({
      id: entry.id,
      sequence: entry.sequence,
      eventType: entry.eventType,
      reason: entry.reason,
      snapshot: entry.snapshotJson,
      actorId: entry.actorId,
      createdAt: entry.createdAt.toISOString()
    }))
  };
}

function serializeIssueCapture(capture: IssueCaptureFact) {
  return {
    id: capture.id,
    projectId: capture.projectId,
    inputText: capture.inputText,
    voiceFile: capture.voiceFile
      ? {
          id: capture.voiceFile.id,
          sha256: capture.voiceFileSha256,
          mimeType: capture.voiceFile.verifiedMimeType ?? capture.voiceFile.declaredMimeType,
          sensitivity: capture.voiceFile.sensitivity
        }
      : null,
    mediaFiles: capture.attachments.map((attachment) => ({
      id: attachment.fileId,
      sha256: attachment.fileSha256,
      mimeType: attachment.file.verifiedMimeType ?? attachment.file.declaredMimeType,
      sensitivity: attachment.file.sensitivity
    })),
    status: capture.status,
    issueId: capture.issueId,
    version: capture.version,
    createdById: capture.createdById,
    createdAt: capture.createdAt.toISOString(),
    confirmedAt: capture.confirmedAt?.toISOString() ?? null,
    allowedActions: capture.status === "PENDING_CONFIRMATION" ? ["CONFIRM"] : []
  };
}

function issueCaptureAuditValue(capture: ReturnType<typeof serializeIssueCapture>, reason: string) {
  return {
    projectId: capture.projectId,
    captureId: capture.id,
    status: capture.status,
    hasInputText: capture.inputText !== null,
    voiceFileId: capture.voiceFile?.id ?? null,
    voiceFileSha256: capture.voiceFile?.sha256 ?? null,
    mediaCount: capture.mediaFiles.length,
    issueId: capture.issueId,
    version: capture.version,
    reason
  };
}

async function lockAndReadIssueCaptureFiles(
  client: Prisma.TransactionClient,
  input: {
    projectId: string;
    voiceFileId: string | null;
    mediaFileIds: string[];
    expectedSha256?: Map<string, string>;
    access?: IssueCaptureFileAccess;
  }
) {
  const requested = [
    ...(input.voiceFileId ? [{ id: input.voiceFileId, kind: "VOICE" as const }] : []),
    ...input.mediaFileIds.map((id) => ({ id, kind: "MEDIA" as const }))
  ];
  if (new Set(requested.map((file) => file.id)).size !== requested.length) {
    throw new IssueServiceError(
      "ISSUE_CAPTURE_INVALID_INPUT",
      "语音文件不得重复作为媒体附件。",
      422
    );
  }
  for (const fileId of requested.map((file) => file.id).sort()) {
    await client.$queryRaw`
      SELECT "id" FROM "file_objects"
      WHERE "id" = ${fileId} AND "project_id" = ${input.projectId}
      FOR UPDATE
    `;
  }
  const facts = await client.fileObject.findMany({
    where: { projectId: input.projectId, id: { in: requested.map((file) => file.id) } },
    select: issueCaptureFileSelect
  });
  const byId = new Map(facts.map((file) => [file.id, file]));
  for (const requestedFile of requested) {
    const file = byId.get(requestedFile.id);
    if (!file) {
      throw new IssueServiceError(
        "ISSUE_CAPTURE_FILE_NOT_FOUND",
        "录入文件不存在或不属于该项目。",
        404
      );
    }
    const mimeType = file.verifiedMimeType ?? file.declaredMimeType;
    if (file.status !== "AVAILABLE" || !file.sha256) {
      throw new IssueServiceError(
        "ISSUE_CAPTURE_FILE_NOT_AVAILABLE",
        "录入文件必须完成扫描并处于可用状态。",
        409
      );
    }
    const expectedSha256 = input.expectedSha256?.get(file.id);
    if (expectedSha256 !== undefined && file.sha256 !== expectedSha256) {
      throw new IssueServiceError(
        "ISSUE_CAPTURE_FILE_CHANGED",
        "录入文件与冻结校验值不一致。",
        409
      );
    }
    if (
      (requestedFile.kind === "VOICE" && !mimeType.startsWith("audio/")) ||
      (requestedFile.kind === "MEDIA" &&
        !mimeType.startsWith("image/") &&
        !mimeType.startsWith("video/"))
    ) {
      throw new IssueServiceError(
        "ISSUE_CAPTURE_FILE_TYPE_INVALID",
        requestedFile.kind === "VOICE" ? "语音文件必须是音频。" : "媒体附件必须是图片或视频。",
        422
      );
    }
    if (file.sensitivity === "RESTRICTED") {
      if (!input.access) {
        throw new IssueServiceError(
          "ISSUE_CAPTURE_SENSITIVE_FILE_DENIED",
          "无权引用严格受限录入文件。",
          403
        );
      }
      const decision = decideAuthorization(input.access.actor, PERMISSIONS.SENSITIVE_FILE_READ, {
        projectId: input.projectId,
        resourceDepartmentId: input.access.projectDepartmentId,
        resourceOwnerId: file.uploadedById,
        memberRoles: input.access.memberRoles
      });
      if (!decision.allowed) {
        throw new IssueServiceError(
          "ISSUE_CAPTURE_SENSITIVE_FILE_DENIED",
          "无权引用严格受限录入文件。",
          403
        );
      }
    }
  }
  return byId;
}

function auditValue(
  issue: ReturnType<typeof serializeIssue>,
  eventType: IssueEventType,
  reason: string
) {
  return {
    projectId: issue.projectId,
    issueId: issue.id,
    title: issue.title,
    sourceType: issue.sourceType,
    category: issue.category,
    severity: issue.severity,
    status: issue.status,
    rootCauseCategory: issue.rootCauseCategory,
    tagCount: issue.tags.length,
    ownerMembershipId: issue.ownerMembershipId,
    verifierMembershipId: issue.verifierMembershipId,
    dueDate: issue.dueDate,
    isBlocked: issue.isBlocked,
    isOverdue: issue.isOverdue,
    eventType,
    reason,
    version: issue.version
  };
}

function historySnapshot(
  issue: ReturnType<typeof serializeIssue>,
  eventType: IssueEventType,
  reason: string,
  sourceSnapshot?: Record<string, unknown>
) {
  return {
    ...auditValue(issue, eventType, reason),
    confirmedText: issue.confirmedText,
    phenomenonDescription: issue.phenomenonDescription,
    rootCauseDescription: issue.rootCauseDescription,
    verificationEvidence: issue.verificationEvidence,
    tags: issue.tags.map((tag) => tag.tag),
    ...(sourceSnapshot ? { sourceSnapshot } : {})
  };
}

function relationAuditValue(
  issue: ReturnType<typeof serializeIssue>,
  relation: ReturnType<typeof serializeIssueRelation>,
  eventType: IssueEventType,
  reason: string
) {
  return {
    ...auditValue(issue, eventType, reason),
    relationId: relation.id,
    relationType: relation.relationType,
    targetId: relation.targetId,
    relationStatus: relation.status
  };
}

function historyEvent(action: IssueAction): IssueEventType {
  switch (action) {
    case "START_ANALYSIS":
      return "STARTED_ANALYSIS";
    case "START_PROCESSING":
      return "STARTED_PROCESSING";
    case "SUBMIT_VERIFICATION":
      return "VERIFICATION_SUBMITTED";
    case "VERIFY_CLOSE":
      return "CLOSED";
    case "REOPEN":
      return "REOPENED";
  }
}

function issueActionAudit(action: IssueAction) {
  if (action === "REOPEN") return AUDIT_ACTIONS.ISSUE_REOPENED;
  return AUDIT_ACTIONS.ISSUE_STATUS_CHANGED;
}

async function databaseNow(client: Prisma.TransactionClient | typeof db): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  if (!clock) throw new Error("无法读取数据库时间。 ");
  return clock.now;
}

async function lockIssue(client: Prisma.TransactionClient, projectId: string, issueId: string) {
  await client.$queryRaw`
    SELECT "id" FROM "issues" WHERE "id" = ${issueId} AND "project_id" = ${projectId} FOR UPDATE
  `;
  return client.issue.findFirst({ where: { id: issueId, projectId }, include: issueInclude });
}

async function lockProject(client: Prisma.TransactionClient, projectId: string) {
  await client.$queryRaw`
    SELECT "id" FROM "projects" WHERE "id" = ${projectId} FOR UPDATE
  `;
  return client.project.findUnique({ where: { id: projectId } });
}

async function lockIssueCapture(
  client: Prisma.TransactionClient,
  projectId: string,
  captureId: string
) {
  await client.$queryRaw`
    SELECT "id" FROM "issue_captures"
    WHERE "id" = ${captureId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  return client.issueCapture.findFirst({
    where: { id: captureId, projectId },
    include: issueCaptureInclude
  });
}

async function activeIssueMembership(
  client: Prisma.TransactionClient,
  projectId: string,
  membershipId: string,
  field: string
) {
  const membership = await client.projectMember.findFirst({
    where: {
      id: membershipId,
      projectId,
      leftAt: null,
      user: { status: UserStatus.ACTIVE }
    },
    include: { user: true }
  });
  if (!membership) {
    throw new IssueServiceError("ISSUE_MEMBER_INVALID", `${field} 必须是当前项目的有效成员。`, 422);
  }
  return membership;
}

function isActiveIssueMembership(
  membership: IssueFact["ownerMembership"] | IssueFact["verifierMembership"]
): boolean {
  return Boolean(
    membership && membership.leftAt === null && membership.user.status === UserStatus.ACTIVE
  );
}

function assertIndependentVerificationAssignment(issue: IssueFact, actorId?: string) {
  const owner = issue.ownerMembership;
  const verifier = issue.verifierMembership;
  if (
    !owner ||
    !verifier ||
    !isActiveIssueMembership(owner) ||
    !isActiveIssueMembership(verifier)
  ) {
    throw new IssueServiceError(
      "ISSUE_VERIFIER_REQUIRED",
      "高严重度问题必须有当前有效的 Owner 和独立验证人。",
      422
    );
  }
  if (owner.userId === verifier.userId) {
    throw new IssueServiceError(
      "ISSUE_VERIFIER_NOT_INDEPENDENT",
      "高严重度问题的验证人不得与 Owner 相同。",
      422
    );
  }
  if (actorId && verifier.userId !== actorId) {
    throw new IssueServiceError(
      "ISSUE_VERIFIER_FORBIDDEN",
      "只有当前独立验证人可以关闭高严重度问题。",
      403
    );
  }
}

const ISSUE_RELATION_TYPES = [
  "TASK",
  "GATE_INSTANCE",
  "DRAWING_VERSION",
  "TEST_RESULT",
  "BLOCKED_BY_ISSUE",
  "UPH_SOURCE_BATCH",
  "UPH_ANALYSIS",
  "UPH_RETEST_BATCH"
] as const;

type IssueRelationType = (typeof ISSUE_RELATION_TYPES)[number];

function issueRelationType(value: unknown): IssueRelationType {
  if (!ISSUE_RELATION_TYPES.includes(value as IssueRelationType)) {
    throw new IssueServiceError("ISSUE_INVALID_INPUT", "relationType 未注册。", 422);
  }
  return value as IssueRelationType;
}

async function lockIssueRelation(
  client: Prisma.TransactionClient,
  projectId: string,
  issueId: string,
  relationId: string
) {
  await client.$queryRaw`
    SELECT "id" FROM "issue_relations"
    WHERE "id" = ${relationId} AND "project_id" = ${projectId} AND "issue_id" = ${issueId}
    FOR UPDATE
  `;
  return client.issueRelation.findFirst({
    where: { id: relationId, projectId, issueId },
    include: { blockerIssue: { select: { status: true } } }
  });
}

async function assertIssueRelationTarget(
  client: Prisma.TransactionClient,
  projectId: string,
  issueId: string,
  relationType: IssueRelationType,
  targetId: string
) {
  if (relationType === "TASK") {
    const task = await client.planningTask.findFirst({ where: { id: targetId, projectId } });
    if (!task) {
      throw new IssueServiceError(
        "ISSUE_RELATION_TARGET_NOT_FOUND",
        "关联任务不存在或不属于该项目。",
        404
      );
    }
    return null;
  }
  if (relationType === "GATE_INSTANCE") {
    const gate = await client.projectGateInstance.findFirst({ where: { id: targetId, projectId } });
    if (!gate) {
      throw new IssueServiceError(
        "ISSUE_RELATION_TARGET_NOT_FOUND",
        "关联 Gate 不存在或不属于该项目。",
        404
      );
    }
    return null;
  }
  if (relationType === "BLOCKED_BY_ISSUE") {
    if (targetId === issueId) {
      throw new IssueServiceError("ISSUE_RELATION_SELF_REFERENCE", "问题不能阻塞自身。", 422);
    }
    const blocker = await client.issue.findFirst({ where: { id: targetId, projectId } });
    if (!blocker) {
      throw new IssueServiceError(
        "ISSUE_RELATION_TARGET_NOT_FOUND",
        "阻塞问题不存在或不属于该项目。",
        404
      );
    }
    return blocker;
  }
  if (relationType === "TEST_RESULT") {
    const revision = await client.acceptanceTestResultRevision.findFirst({
      where: { id: targetId, projectId },
      select: { id: true, decision: true }
    });
    if (!revision) {
      throw new IssueServiceError(
        "ISSUE_RELATION_TARGET_NOT_FOUND",
        "验收结果修订不存在或不属于该项目。",
        404
      );
    }
    if (revision.decision !== "FAIL") {
      throw new IssueServiceError(
        "ACCEPTANCE_FAILURE_DECISION_REQUIRED",
        "只有 FAIL 结果修订可以关联统一问题。",
        422
      );
    }
    return null;
  }
  if (relationType === "UPH_SOURCE_BATCH") {
    const batch = await client.projectUphTestBatch.findFirst({
      where: { id: targetId, projectId }
    });
    if (!batch)
      throw new IssueServiceError(
        "ISSUE_RELATION_TARGET_NOT_FOUND",
        "UPH测试批次不存在或不属于该项目。",
        404
      );
    return null;
  }
  if (relationType === "UPH_ANALYSIS") {
    const analysis = await client.projectUphAnalysisSnapshot.findFirst({
      where: { id: targetId, projectId }
    });
    if (!analysis)
      throw new IssueServiceError(
        "ISSUE_RELATION_TARGET_NOT_FOUND",
        "UPH分析快照不存在或不属于该项目。",
        404
      );
    return null;
  }
  if (relationType === "UPH_RETEST_BATCH") {
    const batch = await client.projectUphTestBatch.findFirst({
      where: { id: targetId, projectId }
    });
    if (!batch)
      throw new IssueServiceError(
        "ISSUE_RELATION_TARGET_NOT_FOUND",
        "UPH复测批次不存在或不属于该项目。",
        404
      );
    return null;
  }
  return null;
}

export function assertProjectIssuesWritable(status: string) {
  if (status === "CLOSED" || status === "CANCELED") {
    throw new IssueServiceError("PROJECT_READ_ONLY", "已关闭或取消项目不能写入问题。", 409);
  }
}

async function appendHistory(
  client: Prisma.TransactionClient,
  input: {
    issueId: string;
    projectId: string;
    eventType: IssueEventType;
    reason: string;
    snapshot: Record<string, unknown>;
    actorId: string;
  }
) {
  const sequence = (await client.issueHistory.count({ where: { issueId: input.issueId } })) + 1;
  return client.issueHistory.create({
    data: {
      issueId: input.issueId,
      projectId: input.projectId,
      sequence,
      eventType: input.eventType,
      reason: input.reason,
      snapshotJson: input.snapshot as Prisma.InputJsonValue,
      actorId: input.actorId
    }
  });
}

async function readIssueOrThrow(
  client: Prisma.TransactionClient,
  projectId: string,
  issueId: string
) {
  const issue = await client.issue.findFirst({
    where: { id: issueId, projectId },
    include: issueInclude
  });
  if (!issue) throw new IssueServiceError("ISSUE_NOT_FOUND", "问题不存在或不属于该项目。", 404);
  return issue;
}

function context(
  input: { actorId: string; auditContext: AuditContext },
  projectId: string,
  reason: string
) {
  return { ...input.auditContext, actorId: input.actorId, projectId, reason };
}

export async function createIssueCapture(
  input: {
    projectId: string;
    inputText?: unknown;
    voiceFileId?: unknown;
    mediaFileIds?: unknown;
    actorId: string;
    fileAccess?: IssueCaptureFileAccess;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = requiredText(input.projectId, "projectId", 191);
  const inputText = optionalCaptureText(input.inputText);
  const voiceFileId = optionalIdentifier(input.voiceFileId, "voiceFileId");
  const mediaFileIds = captureMediaFileIds(input.mediaFileIds);
  if (!inputText && !voiceFileId) {
    throw new IssueServiceError(
      "ISSUE_CAPTURE_INPUT_REQUIRED",
      "inputText 与 voiceFileId 至少提供一项。",
      422
    );
  }
  if (voiceFileId && mediaFileIds.includes(voiceFileId)) {
    throw new IssueServiceError(
      "ISSUE_CAPTURE_INVALID_INPUT",
      "语音文件不得重复作为媒体附件。",
      422
    );
  }
  return inTransaction(transaction, async (client) => {
    const project = await lockProject(client, projectId);
    if (!project) throw new IssueServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    assertProjectIssuesWritable(project.status);
    const files = await lockAndReadIssueCaptureFiles(client, {
      projectId,
      voiceFileId,
      mediaFileIds,
      access: input.fileAccess
    });
    const capture = await client.issueCapture.create({
      data: {
        projectId,
        inputText,
        voiceFileId,
        voiceFileSha256: voiceFileId ? files.get(voiceFileId)!.sha256 : null,
        createdById: input.actorId,
        attachments: {
          create: mediaFileIds.map((fileId) => ({
            projectId,
            fileId,
            fileSha256: files.get(fileId)!.sha256!
          }))
        }
      },
      include: issueCaptureInclude
    });
    const serialized = serializeIssueCapture(capture);
    const reason = "保存移动端问题录入，等待用户确认文字。";
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.ISSUE_CAPTURE_CREATED,
      objectType: AUDIT_OBJECT_TYPES.ISSUE_CAPTURE,
      objectId: capture.id,
      context: context(input, projectId, reason),
      after: {
        value: issueCaptureAuditValue(serialized, reason),
        allowedFields: ISSUE_CAPTURE_AUDIT_FIELDS
      }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "issues.issue-capture.created",
      aggregateType: "ISSUE_CAPTURE",
      aggregateId: capture.id,
      idempotencyKey: capture.id,
      payload: { ...issueCaptureAuditValue(serialized, reason), auditId: audit.id }
    });
    return { capture: serialized, auditId: audit.id, outboxEventId: outbox.id };
  });
}

export async function createProjectIssue(
  input: {
    projectId: string;
    title: unknown;
    confirmedText: unknown;
    category: unknown;
    severity: unknown;
    phenomenonDescription: unknown;
    rootCauseCategory: unknown;
    rootCauseDescription: unknown;
    tags: unknown;
    sourceType?: unknown;
    sourceSnapshot?: Record<string, unknown>;
    creationReason?: string;
    captureId?: unknown;
    captureVersion?: unknown;
    captureFileAccess?: IssueCaptureFileAccess;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = requiredText(input.projectId, "projectId", 191);
  const value = details(input);
  const issueSourceType = input.sourceType === undefined ? "PROJECT" : sourceType(input.sourceType);
  const captureId = optionalIdentifier(input.captureId, "captureId");
  const expectedCaptureVersion =
    input.captureVersion === undefined ? null : version(input.captureVersion);
  if ((captureId === null) !== (expectedCaptureVersion === null)) {
    throw new IssueServiceError(
      "ISSUE_CAPTURE_INVALID_INPUT",
      "captureId 与 captureVersion 必须同时提供或同时省略。",
      422
    );
  }
  if (captureId && issueSourceType !== "PROJECT") {
    throw new IssueServiceError(
      "ISSUE_CAPTURE_SOURCE_INVALID",
      "移动端录入只能创建项目来源问题。",
      422
    );
  }
  const phenomenonDescription = captureId ? value.confirmedText : value.phenomenonDescription;
  return inTransaction(transaction, async (client) => {
    const project = await lockProject(client, projectId);
    if (!project) throw new IssueServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    assertProjectIssuesWritable(project.status);
    let pendingCapture: IssueCaptureFact | null = null;
    let captureSourceSnapshot: Record<string, unknown> | undefined;
    if (captureId && expectedCaptureVersion !== null) {
      pendingCapture = await lockIssueCapture(client, projectId, captureId);
      if (!pendingCapture || pendingCapture.createdById !== input.actorId) {
        throw new IssueServiceError(
          "ISSUE_CAPTURE_NOT_FOUND",
          "移动端问题录入不存在或不属于当前用户。",
          404
        );
      }
      if (pendingCapture.status !== "PENDING_CONFIRMATION") {
        throw new IssueServiceError(
          "ISSUE_CAPTURE_ALREADY_CONFIRMED",
          "移动端问题录入已确认。",
          409
        );
      }
      if (pendingCapture.version !== expectedCaptureVersion) {
        throw new IssueServiceError(
          "ISSUE_CAPTURE_VERSION_CONFLICT",
          "移动端问题录入版本冲突。",
          409
        );
      }
      const expectedSha256 = new Map<string, string>();
      if (pendingCapture.voiceFileId && pendingCapture.voiceFileSha256) {
        expectedSha256.set(pendingCapture.voiceFileId, pendingCapture.voiceFileSha256);
      }
      for (const attachment of pendingCapture.attachments) {
        expectedSha256.set(attachment.fileId, attachment.fileSha256);
      }
      const files = await lockAndReadIssueCaptureFiles(client, {
        projectId,
        voiceFileId: pendingCapture.voiceFileId,
        mediaFileIds: pendingCapture.attachments.map((attachment) => attachment.fileId),
        expectedSha256,
        access: input.captureFileAccess
      });
      captureSourceSnapshot = {
        captureId: pendingCapture.id,
        captureVersion: pendingCapture.version,
        inputText: pendingCapture.inputText,
        voiceFile: pendingCapture.voiceFileId
          ? {
              id: pendingCapture.voiceFileId,
              sha256: pendingCapture.voiceFileSha256,
              mimeType:
                files.get(pendingCapture.voiceFileId)!.verifiedMimeType ??
                files.get(pendingCapture.voiceFileId)!.declaredMimeType
            }
          : null,
        mediaFiles: pendingCapture.attachments.map((attachment) => ({
          id: attachment.fileId,
          sha256: attachment.fileSha256,
          mimeType:
            files.get(attachment.fileId)!.verifiedMimeType ??
            files.get(attachment.fileId)!.declaredMimeType
        }))
      };
    }
    const issue = await client.issue.create({
      data: {
        projectId,
        title: value.title,
        confirmedText: value.confirmedText,
        sourceType: issueSourceType,
        category: value.category,
        severity: value.severity,
        phenomenonDescription,
        rootCauseCategory: value.rootCauseCategory,
        rootCauseDescription: value.rootCauseDescription,
        createdById: input.actorId,
        updatedById: input.actorId,
        tags: { create: value.tags.map((tag) => ({ tag })) }
      },
      include: issueInclude
    });
    const confirmedCapture = pendingCapture
      ? await client.issueCapture.update({
          where: { id: pendingCapture.id },
          data: { status: "CONFIRMED", issueId: issue.id, version: { increment: 1 } },
          include: issueCaptureInclude
        })
      : null;
    const now = await databaseNow(client);
    const serialized = serializeIssue(issue, now);
    const reason = input.creationReason ?? "创建统一问题主记录。";
    await appendHistory(client, {
      issueId: issue.id,
      projectId,
      eventType: "CREATED",
      reason,
      snapshot: historySnapshot(
        serialized,
        "CREATED",
        reason,
        captureSourceSnapshot
          ? { ...(input.sourceSnapshot ?? {}), issueCapture: captureSourceSnapshot }
          : input.sourceSnapshot
      ),
      actorId: input.actorId
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.ISSUE_CREATED,
      objectType: AUDIT_OBJECT_TYPES.ISSUE,
      objectId: issue.id,
      context: context(input, projectId, reason),
      after: { value: auditValue(serialized, "CREATED", reason), allowedFields: ISSUE_AUDIT_FIELDS }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "issues.issue.created",
      aggregateType: "ISSUE",
      aggregateId: issue.id,
      idempotencyKey: issue.id,
      payload: { ...auditValue(serialized, "CREATED", reason), auditId: audit.id }
    });
    let captureAuditId: string | null = null;
    let captureOutboxEventId: string | null = null;
    if (confirmedCapture) {
      const captureSerialized = serializeIssueCapture(confirmedCapture);
      const captureReason = "用户确认文字并创建正式问题。";
      const captureAudit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ISSUE_CAPTURE_CONFIRMED,
        objectType: AUDIT_OBJECT_TYPES.ISSUE_CAPTURE,
        objectId: confirmedCapture.id,
        context: context(input, projectId, captureReason),
        before: {
          value: issueCaptureAuditValue(serializeIssueCapture(pendingCapture!), captureReason),
          allowedFields: ISSUE_CAPTURE_AUDIT_FIELDS
        },
        after: {
          value: issueCaptureAuditValue(captureSerialized, captureReason),
          allowedFields: ISSUE_CAPTURE_AUDIT_FIELDS
        }
      });
      const captureOutbox = await appendOutboxEvent(client, {
        eventType: "issues.issue-capture.confirmed",
        aggregateType: "ISSUE_CAPTURE",
        aggregateId: confirmedCapture.id,
        idempotencyKey: `${confirmedCapture.id}:${confirmedCapture.version}`,
        payload: {
          ...issueCaptureAuditValue(captureSerialized, captureReason),
          auditId: captureAudit.id
        }
      });
      captureAuditId = captureAudit.id;
      captureOutboxEventId = captureOutbox.id;
    }
    return {
      issue: serializeIssue(await readIssueOrThrow(client, projectId, issue.id), now),
      auditId: audit.id,
      outboxEventId: outbox.id,
      ...(confirmedCapture
        ? {
            capture: serializeIssueCapture(confirmedCapture),
            captureAuditId,
            captureOutboxEventId
          }
        : {})
    };
  });
}

export async function updateProjectIssue(
  input: {
    projectId: string;
    issueId: string;
    version: unknown;
    title: unknown;
    confirmedText: unknown;
    category: unknown;
    severity: unknown;
    phenomenonDescription: unknown;
    rootCauseCategory: unknown;
    rootCauseDescription: unknown;
    tags: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = requiredText(input.projectId, "projectId", 191);
  const issueId = requiredText(input.issueId, "issueId", 191);
  const expectedVersion = version(input.version);
  const reason = requiredText(input.reason, "reason", 1024);
  const value = details(input);
  return inTransaction(transaction, async (client) => {
    const project = await lockProject(client, projectId);
    if (!project) throw new IssueServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    assertProjectIssuesWritable(project.status);
    const current = await lockIssue(client, projectId, issueId);
    if (!current) throw new IssueServiceError("ISSUE_NOT_FOUND", "问题不存在或不属于该项目。", 404);
    if (current.status === "CLOSED") {
      throw new IssueServiceError("ISSUE_CLOSED", "已关闭问题必须先重开才能更新详情。", 409);
    }
    const now = await databaseNow(client);
    const updated = await client.issue.updateMany({
      where: { id: issueId, projectId, version: expectedVersion },
      data: {
        title: value.title,
        confirmedText: value.confirmedText,
        category: value.category,
        severity: value.severity,
        phenomenonDescription: value.phenomenonDescription,
        rootCauseCategory: value.rootCauseCategory,
        rootCauseDescription: value.rootCauseDescription,
        updatedById: input.actorId,
        version: { increment: 1 }
      }
    });
    if (updated.count !== 1) {
      throw new IssueServiceError("VERSION_CONFLICT", "问题已被其他操作更新。", 409);
    }
    await client.issueTag.deleteMany({ where: { issueId } });
    if (value.tags.length > 0) {
      await client.issueTag.createMany({
        data: value.tags.map((tag) => ({ projectId, issueId, tag }))
      });
    }
    const issue = serializeIssue(await readIssueOrThrow(client, projectId, issueId), now);
    await appendHistory(client, {
      issueId,
      projectId,
      eventType: "DETAILS_UPDATED",
      reason,
      snapshot: {
        before: historySnapshot(serializeIssue(current, now), "DETAILS_UPDATED", reason),
        after: historySnapshot(issue, "DETAILS_UPDATED", reason)
      },
      actorId: input.actorId
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.ISSUE_UPDATED,
      objectType: AUDIT_OBJECT_TYPES.ISSUE,
      objectId: issueId,
      context: context(input, projectId, reason),
      before: {
        value: auditValue(serializeIssue(current, now), "DETAILS_UPDATED", reason),
        allowedFields: ISSUE_AUDIT_FIELDS
      },
      after: {
        value: auditValue(issue, "DETAILS_UPDATED", reason),
        allowedFields: ISSUE_AUDIT_FIELDS
      }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "issues.issue.updated",
      aggregateType: "ISSUE",
      aggregateId: issueId,
      idempotencyKey: `${issueId}:version:${issue.version}`,
      payload: { ...auditValue(issue, "DETAILS_UPDATED", reason), auditId: audit.id }
    });
    return {
      issue: serializeIssue(await readIssueOrThrow(client, projectId, issueId), now),
      auditId: audit.id,
      outboxEventId: outbox.id
    };
  });
}

export async function assignProjectIssueResponsibility(
  input: {
    projectId: string;
    issueId: string;
    version: unknown;
    ownerMembershipId: unknown;
    verifierMembershipId: unknown;
    dueDate: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = requiredText(input.projectId, "projectId", 191);
  const issueId = requiredText(input.issueId, "issueId", 191);
  const expectedVersion = version(input.version);
  const ownerMembershipId = requiredText(input.ownerMembershipId, "ownerMembershipId", 191);
  const verifierMembershipId = optionalText(
    input.verifierMembershipId,
    "verifierMembershipId",
    191
  );
  const assignedDueDate = dueDate(input.dueDate);
  const reason = requiredText(input.reason, "reason", 1024);
  return inTransaction(transaction, async (client) => {
    const project = await lockProject(client, projectId);
    if (!project) throw new IssueServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    assertProjectIssuesWritable(project.status);
    const current = await lockIssue(client, projectId, issueId);
    if (!current) throw new IssueServiceError("ISSUE_NOT_FOUND", "问题不存在或不属于该项目。", 404);
    if (current.status === "CLOSED") {
      throw new IssueServiceError("ISSUE_CLOSED", "已关闭问题必须先重开才能调整责任。", 409);
    }
    const ownerMembership = await activeIssueMembership(
      client,
      projectId,
      ownerMembershipId,
      "ownerMembershipId"
    );
    const verifierMembership = verifierMembershipId
      ? await activeIssueMembership(client, projectId, verifierMembershipId, "verifierMembershipId")
      : null;
    if (requiresIndependentVerification(current.severity as IssueSeverity)) {
      if (!verifierMembershipId) {
        throw new IssueServiceError(
          "ISSUE_VERIFIER_REQUIRED",
          "高严重度问题必须指定独立验证人。",
          422
        );
      }
      if (
        !verifierMembership ||
        ownerMembershipId === verifierMembershipId ||
        ownerMembership.userId === verifierMembership.userId
      ) {
        throw new IssueServiceError(
          "ISSUE_VERIFIER_NOT_INDEPENDENT",
          "高严重度问题的验证人不得与 Owner 相同。",
          422
        );
      }
    }
    const now = await databaseNow(client);
    const updated = await client.issue.updateMany({
      where: { id: issueId, projectId, version: expectedVersion },
      data: {
        ownerMembershipId,
        verifierMembershipId,
        dueDate: assignedDueDate,
        updatedById: input.actorId,
        version: { increment: 1 }
      }
    });
    if (updated.count !== 1) {
      throw new IssueServiceError("VERSION_CONFLICT", "问题已被其他操作更新。", 409);
    }
    const issue = serializeIssue(await readIssueOrThrow(client, projectId, issueId), now);
    await appendHistory(client, {
      issueId,
      projectId,
      eventType: "RESPONSIBILITY_ASSIGNED",
      reason,
      snapshot: {
        before: historySnapshot(serializeIssue(current, now), "RESPONSIBILITY_ASSIGNED", reason),
        after: historySnapshot(issue, "RESPONSIBILITY_ASSIGNED", reason)
      },
      actorId: input.actorId
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.ISSUE_RESPONSIBILITY_ASSIGNED,
      objectType: AUDIT_OBJECT_TYPES.ISSUE,
      objectId: issueId,
      context: context(input, projectId, reason),
      before: {
        value: auditValue(serializeIssue(current, now), "RESPONSIBILITY_ASSIGNED", reason),
        allowedFields: ISSUE_AUDIT_FIELDS
      },
      after: {
        value: auditValue(issue, "RESPONSIBILITY_ASSIGNED", reason),
        allowedFields: ISSUE_AUDIT_FIELDS
      }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "issues.issue.responsibility-assigned",
      aggregateType: "ISSUE",
      aggregateId: issueId,
      idempotencyKey: `${issueId}:version:${issue.version}`,
      payload: { ...auditValue(issue, "RESPONSIBILITY_ASSIGNED", reason), auditId: audit.id }
    });
    return {
      issue,
      auditId: audit.id,
      outboxEventId: outbox.id
    };
  });
}

export async function addProjectIssueRelation(
  input: {
    projectId: string;
    issueId: string;
    version: unknown;
    relationType: unknown;
    targetId: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = requiredText(input.projectId, "projectId", 191);
  const issueId = requiredText(input.issueId, "issueId", 191);
  const expectedVersion = version(input.version);
  const relationType = issueRelationType(input.relationType);
  if (
    relationType === "UPH_SOURCE_BATCH" ||
    relationType === "UPH_ANALYSIS" ||
    relationType === "UPH_RETEST_BATCH"
  ) {
    throw new IssueServiceError(
      "ISSUE_RELATION_TYPE_RESERVED",
      "UPH关联必须通过专用性能问题服务创建。",
      422
    );
  }
  const targetId = requiredText(input.targetId, "targetId", 191);
  const reason = requiredText(input.reason, "reason", 1024);
  try {
    return await inTransaction(transaction, async (client) => {
      const project = await lockProject(client, projectId);
      if (!project) throw new IssueServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
      assertProjectIssuesWritable(project.status);
      const current = await lockIssue(client, projectId, issueId);
      if (!current)
        throw new IssueServiceError("ISSUE_NOT_FOUND", "问题不存在或不属于该项目。", 404);
      if (current.status === "CLOSED") {
        throw new IssueServiceError("ISSUE_CLOSED", "已关闭问题必须先重开才能新增关联。", 409);
      }
      if (
        current.relations.some(
          (relation) =>
            relation.status === "ACTIVE" &&
            relation.relationType === relationType &&
            relation.targetId === targetId
        )
      ) {
        throw new IssueServiceError("ISSUE_RELATION_EXISTS", "问题已存在相同的有效关联。", 409);
      }
      const blocker = await assertIssueRelationTarget(
        client,
        projectId,
        issueId,
        relationType,
        targetId
      );
      const now = await databaseNow(client);
      const updated = await client.issue.updateMany({
        where: { id: issueId, projectId, version: expectedVersion },
        data: { updatedById: input.actorId, version: { increment: 1 } }
      });
      if (updated.count !== 1) {
        throw new IssueServiceError("VERSION_CONFLICT", "问题已被其他操作更新。", 409);
      }
      const relation = await client.issueRelation.create({
        data: {
          projectId,
          issueId,
          relationType,
          targetId,
          blockerIssueId: blocker?.id ?? null,
          reason,
          createdById: input.actorId
        },
        include: { blockerIssue: { select: { status: true } } }
      });
      const issue = serializeIssue(await readIssueOrThrow(client, projectId, issueId), now);
      const relationFact = serializeIssueRelation(relation);
      await appendHistory(client, {
        issueId,
        projectId,
        eventType: "RELATION_ADDED",
        reason,
        snapshot: {
          before: historySnapshot(serializeIssue(current, now), "RELATION_ADDED", reason),
          after: historySnapshot(issue, "RELATION_ADDED", reason),
          relation: relationFact
        },
        actorId: input.actorId
      });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ISSUE_RELATION_ADDED,
        objectType: AUDIT_OBJECT_TYPES.ISSUE_RELATION,
        objectId: relation.id,
        context: context(input, projectId, reason),
        after: {
          value: relationAuditValue(issue, relationFact, "RELATION_ADDED", reason),
          allowedFields: ISSUE_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "issues.issue-relation.added",
        aggregateType: "ISSUE_RELATION",
        aggregateId: relation.id,
        idempotencyKey: relation.id,
        payload: {
          issue: auditValue(issue, "RELATION_ADDED", reason),
          relation: relationFact,
          auditId: audit.id
        }
      });
      return { issue, relation: relationFact, auditId: audit.id, outboxEventId: outbox.id };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new IssueServiceError("ISSUE_RELATION_EXISTS", "问题已存在相同的有效关联。", 409);
    }
    throw error;
  }
}

export async function closeProjectIssueRelation(
  input: {
    projectId: string;
    issueId: string;
    relationId: string;
    version: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = requiredText(input.projectId, "projectId", 191);
  const issueId = requiredText(input.issueId, "issueId", 191);
  const relationId = requiredText(input.relationId, "relationId", 191);
  const expectedVersion = version(input.version);
  const reason = requiredText(input.reason, "reason", 1024);
  return inTransaction(transaction, async (client) => {
    const project = await lockProject(client, projectId);
    if (!project) throw new IssueServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    assertProjectIssuesWritable(project.status);
    const current = await lockIssue(client, projectId, issueId);
    if (!current) throw new IssueServiceError("ISSUE_NOT_FOUND", "问题不存在或不属于该项目。", 404);
    if (current.status === "CLOSED") {
      throw new IssueServiceError("ISSUE_CLOSED", "已关闭问题必须先重开才能关闭关联。", 409);
    }
    const currentRelation = await lockIssueRelation(client, projectId, issueId, relationId);
    if (!currentRelation) {
      throw new IssueServiceError(
        "ISSUE_RELATION_NOT_FOUND",
        "问题关联不存在或不属于该项目。",
        404
      );
    }
    if (currentRelation.status === "CLOSED") {
      throw new IssueServiceError("ISSUE_RELATION_CLOSED", "问题关联已关闭。", 409);
    }
    const now = await databaseNow(client);
    const updated = await client.issue.updateMany({
      where: { id: issueId, projectId, version: expectedVersion },
      data: { updatedById: input.actorId, version: { increment: 1 } }
    });
    if (updated.count !== 1) {
      throw new IssueServiceError("VERSION_CONFLICT", "问题已被其他操作更新。", 409);
    }
    const relation = await client.issueRelation.update({
      where: { id: relationId },
      data: {
        status: "CLOSED",
        closedReason: reason,
        closedById: input.actorId,
        closedAt: now
      },
      include: { blockerIssue: { select: { status: true } } }
    });
    const issue = serializeIssue(await readIssueOrThrow(client, projectId, issueId), now);
    const beforeRelation = serializeIssueRelation(currentRelation);
    const relationFact = serializeIssueRelation(relation);
    await appendHistory(client, {
      issueId,
      projectId,
      eventType: "RELATION_CLOSED",
      reason,
      snapshot: {
        before: historySnapshot(serializeIssue(current, now), "RELATION_CLOSED", reason),
        after: historySnapshot(issue, "RELATION_CLOSED", reason),
        relation: { before: beforeRelation, after: relationFact }
      },
      actorId: input.actorId
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.ISSUE_RELATION_CLOSED,
      objectType: AUDIT_OBJECT_TYPES.ISSUE_RELATION,
      objectId: relationId,
      context: context(input, projectId, reason),
      before: {
        value: relationAuditValue(issue, beforeRelation, "RELATION_CLOSED", reason),
        allowedFields: ISSUE_AUDIT_FIELDS
      },
      after: {
        value: relationAuditValue(issue, relationFact, "RELATION_CLOSED", reason),
        allowedFields: ISSUE_AUDIT_FIELDS
      }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "issues.issue-relation.closed",
      aggregateType: "ISSUE_RELATION",
      aggregateId: relationId,
      idempotencyKey: `${relationId}:closed`,
      payload: {
        issue: auditValue(issue, "RELATION_CLOSED", reason),
        relation: relationFact,
        auditId: audit.id
      }
    });
    return { issue, relation: relationFact, auditId: audit.id, outboxEventId: outbox.id };
  });
}

export async function transitionProjectIssue(
  input: {
    projectId: string;
    issueId: string;
    version: unknown;
    action: unknown;
    reason: unknown;
    verificationEvidence: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = requiredText(input.projectId, "projectId", 191);
  const issueId = requiredText(input.issueId, "issueId", 191);
  const expectedVersion = version(input.version);
  const requestedAction = action(input.action);
  const reason = requiredText(input.reason, "reason", 1024);
  const evidence = optionalText(input.verificationEvidence, "verificationEvidence", 10_000);
  if (requestedAction === "VERIFY_CLOSE" && !evidence) {
    throw new IssueServiceError(
      "ISSUE_VERIFICATION_EVIDENCE_REQUIRED",
      "关闭问题必须提供验证证据。",
      422
    );
  }
  if (requestedAction !== "VERIFY_CLOSE" && evidence) {
    throw new IssueServiceError("ISSUE_INVALID_INPUT", "只有关闭问题时可以提交验证证据。", 422);
  }
  return inTransaction(transaction, async (client) => {
    const project = await lockProject(client, projectId);
    if (!project) throw new IssueServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    assertProjectIssuesWritable(project.status);
    const current = await lockIssue(client, projectId, issueId);
    if (!current) throw new IssueServiceError("ISSUE_NOT_FOUND", "问题不存在或不属于该项目。", 404);
    if (
      requiresIndependentVerification(current.severity as IssueSeverity) &&
      requestedAction === "SUBMIT_VERIFICATION"
    ) {
      assertIndependentVerificationAssignment(current);
    }
    if (
      requiresIndependentVerification(current.severity as IssueSeverity) &&
      requestedAction === "VERIFY_CLOSE"
    ) {
      assertIndependentVerificationAssignment(current, input.actorId);
    }
    let next: IssueStatus;
    try {
      next = nextIssueStatus(current.status as IssueStatus, requestedAction);
    } catch (error) {
      if (error instanceof IssueLifecycleError) {
        throw new IssueServiceError("ISSUE_TRANSITION_INVALID", error.message, 409);
      }
      throw error;
    }
    const now = await databaseNow(client);
    const updated = await client.issue.updateMany({
      where: { id: issueId, projectId, version: expectedVersion },
      data: {
        status: next,
        statusChangedAt: now,
        updatedById: input.actorId,
        version: { increment: 1 },
        ...(next === "CLOSED"
          ? { closedAt: now, closedById: input.actorId, verificationEvidence: evidence }
          : { closedAt: null, closedById: null, verificationEvidence: null })
      }
    });
    if (updated.count !== 1) {
      throw new IssueServiceError("VERSION_CONFLICT", "问题已被其他操作更新。", 409);
    }
    const eventType = historyEvent(requestedAction);
    const issue = serializeIssue(await readIssueOrThrow(client, projectId, issueId), now);
    await appendHistory(client, {
      issueId,
      projectId,
      eventType,
      reason,
      snapshot: {
        before: historySnapshot(serializeIssue(current, now), eventType, reason),
        after: historySnapshot(issue, eventType, reason)
      },
      actorId: input.actorId
    });
    const audit = await writeAudit(client, {
      action: issueActionAudit(requestedAction),
      objectType: AUDIT_OBJECT_TYPES.ISSUE,
      objectId: issueId,
      context: context(input, projectId, reason),
      before: {
        value: auditValue(serializeIssue(current, now), eventType, reason),
        allowedFields: ISSUE_AUDIT_FIELDS
      },
      after: { value: auditValue(issue, eventType, reason), allowedFields: ISSUE_AUDIT_FIELDS }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType:
        requestedAction === "REOPEN" ? "issues.issue.reopened" : "issues.issue.status-changed",
      aggregateType: "ISSUE",
      aggregateId: issueId,
      idempotencyKey: `${issueId}:version:${issue.version}`,
      payload: { ...auditValue(issue, eventType, reason), auditId: audit.id }
    });
    return {
      issue: serializeIssue(await readIssueOrThrow(client, projectId, issueId), now),
      auditId: audit.id,
      outboxEventId: outbox.id
    };
  });
}

export async function listProjectIssues(input: {
  projectId: string;
  cursor?: string;
  limit: number;
}) {
  if (input.cursor) {
    const cursor = await db.issue.findFirst({
      where: { id: input.cursor, projectId: input.projectId },
      select: { id: true }
    });
    if (!cursor) {
      throw new IssueServiceError(
        "ISSUE_CURSOR_NOT_FOUND",
        "问题列表游标不存在或不属于该项目。",
        404
      );
    }
  }
  const issues = await db.issue.findMany({
    where: { projectId: input.projectId },
    include: issueInclude,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: input.limit + 1
  });
  const page = issues.slice(0, input.limit);
  const now = await databaseNow(db);
  return {
    issues: page.map((issue) => serializeIssue(issue, now)),
    nextCursor: issues.length > input.limit ? (page[page.length - 1]?.id ?? null) : null
  };
}

export async function getProjectIssue(projectId: string, issueId: string) {
  const issue = await db.issue.findFirst({
    where: { id: issueId, projectId },
    include: issueInclude
  });
  if (!issue) throw new IssueServiceError("ISSUE_NOT_FOUND", "问题不存在或不属于该项目。", 404);
  return { issue: serializeIssue(issue, await databaseNow(db)) };
}
