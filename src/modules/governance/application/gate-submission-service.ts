import { GateApprovalDecision, GateSubmissionStatus, Prisma, UserStatus } from "@prisma/client";

import { PROJECT_ROLE_VALUES, type ProjectRoleCode } from "@/lib/auth/permissions";
import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  GATE_APPROVAL_AUDIT_FIELDS,
  GATE_SUBMISSION_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { createGateSubmissionDocumentReferences } from "@/modules/documents/application/controlled-document-service";
import { DocumentReviewError } from "@/modules/documents/domain/document-review";

import {
  evaluateGateSubmissionDecision,
  resolveGateSubmissionApprovers,
  type GateApprovalDecisionCode,
  type GateApprovalModeCode
} from "../domain/gate-submission";
import { appendOutboxEvent } from "../infrastructure/outbox";

export class GateSubmissionServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = "GateSubmissionServiceError";
  }
}

export type GateApprovalConfiguration = {
  mode: GateApprovalModeCode;
  projectRoles: ProjectRoleCode[];
};

const submissionInclude = {
  approvers: true,
  approvals: true,
  documentReferences: { orderBy: [{ documentCode: "asc" }, { documentVersion: "asc" }] }
} satisfies Prisma.GateSubmissionInclude;

type SubmissionWithFacts = Prisma.GateSubmissionGetPayload<{ include: typeof submissionInclude }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : [];
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new GateSubmissionServiceError(
      "GATE_SUBMISSION_VERSION_INVALID",
      "version 必须是正整数。",
      422
    );
  }
  return value as number;
}

function commandReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new GateSubmissionServiceError(
      "GATE_SUBMISSION_REASON_REQUIRED",
      "操作原因必须是 1 到 1024 个字符。",
      422
    );
  }
  return value.trim();
}

export function parseGateApprovalConfiguration(value: unknown): GateApprovalConfiguration {
  if (!isRecord(value) || value.approval === undefined) {
    throw new GateSubmissionServiceError(
      "GATE_APPROVER_CONFIGURATION_MISSING",
      "Gate 定义未配置审批角色，不能提交申请。",
      409
    );
  }
  if (!isRecord(value.approval)) {
    throw new GateSubmissionServiceError(
      "GATE_APPROVER_CONFIGURATION_INVALID",
      "Gate 审批配置无效。",
      409
    );
  }
  const { mode, projectRoles } = value.approval;
  if ((mode !== "ALL" && mode !== "ANY") || !Array.isArray(projectRoles)) {
    throw new GateSubmissionServiceError(
      "GATE_APPROVER_CONFIGURATION_INVALID",
      "Gate 审批配置无效。",
      409
    );
  }
  const roles = projectRoles.filter(
    (projectRole): projectRole is ProjectRoleCode =>
      typeof projectRole === "string" &&
      PROJECT_ROLE_VALUES.includes(projectRole as ProjectRoleCode)
  );
  if (
    roles.length === 0 ||
    roles.length !== projectRoles.length ||
    new Set(roles).size !== roles.length
  ) {
    throw new GateSubmissionServiceError(
      "GATE_APPROVER_CONFIGURATION_INVALID",
      "Gate 审批角色配置无效。",
      409
    );
  }
  return { mode, projectRoles: roles };
}

function submissionSnapshot(submission: SubmissionWithFacts) {
  const approvers = submission.approvers
    .map((approver) => ({
      userId: approver.userId,
      membershipIds: jsonStringArray(approver.membershipIdsJson),
      projectRoles: jsonStringArray(approver.projectRolesJson)
    }))
    .sort((left, right) => left.userId.localeCompare(right.userId));
  return {
    projectId: submission.projectId,
    gateSubmissionId: submission.id,
    gateInstanceId: submission.gateInstanceId,
    gateCheckSnapshotId: submission.gateCheckSnapshotId,
    previousSubmissionId: submission.previousSubmissionId,
    sequence: submission.sequence,
    status: submission.status,
    approvalMode: submission.approvalMode,
    approverProjectRoles: jsonStringArray(submission.approverRolesJson),
    approvers,
    approvals: submission.approvals
      .map((approval) => ({
        gateApprovalId: approval.id,
        userId: approval.decidedById,
        decision: approval.decision,
        decidedAt: approval.decidedAt.toISOString()
      }))
      .sort((left, right) => left.decidedAt.localeCompare(right.decidedAt)),
    documentReferences: submission.documentReferences.map((reference) => ({
      documentReferenceId: reference.id,
      documentVersionId: reference.documentVersionId,
      documentVersionRelationId: reference.documentVersionRelationId,
      documentCode: reference.documentCode,
      documentTitle: reference.documentTitle,
      documentVersion: reference.documentVersion,
      sourceFileSha256: reference.sourceFileSha256,
      reviewEvidence: reference.reviewEvidenceJson,
      reviewEvidenceChecksum: reference.reviewEvidenceChecksum,
      createdAt: reference.createdAt.toISOString()
    })),
    submittedById: submission.submittedById,
    submittedAt: submission.submittedAt.toISOString(),
    withdrawnById: submission.withdrawnById,
    withdrawnAt: submission.withdrawnAt?.toISOString() ?? null,
    withdrawalReason: submission.withdrawalReason,
    decidedAt: submission.decidedAt?.toISOString() ?? null,
    version: submission.version
  };
}

function auditContextFor(
  input: { actorId: string; auditContext: AuditContext },
  project: { id: string; departmentId: string | null },
  reason: string
): AuditContext {
  return {
    ...input.auditContext,
    actorId: input.actorId,
    projectId: project.id,
    departmentId: project.departmentId,
    reason
  };
}

function assertProjectWritable(project: { initializationStatus: string; status: string }) {
  if (project.initializationStatus !== "READY") {
    throw new GateSubmissionServiceError("GATE_PROJECT_NOT_READY", "项目模板快照尚未准备完成。");
  }
  if (project.status === "CLOSED" || project.status === "CANCELED") {
    throw new GateSubmissionServiceError(
      "GATE_PROJECT_READ_ONLY",
      "已关闭或取消项目不能提交 Gate 申请。"
    );
  }
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

async function lockGateInstance(
  client: Prisma.TransactionClient,
  projectId: string,
  gateInstanceId: string
) {
  await client.$queryRaw`
    SELECT "id" FROM "project_gate_instances"
    WHERE "id" = ${gateInstanceId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  return client.projectGateInstance.findFirst({
    where: { id: gateInstanceId, projectId },
    include: { gateDefinition: true }
  });
}

async function lockSubmission(
  client: Prisma.TransactionClient,
  projectId: string,
  submissionId: string
): Promise<SubmissionWithFacts | null> {
  await client.$queryRaw`
    SELECT "id" FROM "gate_submissions"
    WHERE "id" = ${submissionId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  return client.gateSubmission.findFirst({
    where: { id: submissionId, projectId },
    include: submissionInclude
  });
}

async function appendSubmissionEvent(
  client: Prisma.TransactionClient,
  input: {
    submission: SubmissionWithFacts;
    eventType: "SUBMITTED" | "WITHDRAWN" | "APPROVED" | "REJECTED";
    reason: string;
    actorId: string;
  }
) {
  const sequence =
    (await client.gateSubmissionEvent.count({
      where: { gateSubmissionId: input.submission.id }
    })) + 1;
  return client.gateSubmissionEvent.create({
    data: {
      projectId: input.submission.projectId,
      gateSubmissionId: input.submission.id,
      sequence,
      eventType: input.eventType,
      reason: input.reason,
      snapshotJson: submissionSnapshot(input.submission) as Prisma.InputJsonValue,
      actorId: input.actorId
    }
  });
}

async function createSubmission(
  client: Prisma.TransactionClient,
  input: {
    projectId: string;
    gateInstanceId: string;
    actorId: string;
    reason: string;
    auditContext: AuditContext;
    previousSubmissionId?: string;
    expectedGateInstanceVersion?: number;
  }
) {
  const [project, gateInstance] = await Promise.all([
    client.project.findUnique({ where: { id: input.projectId } }),
    lockGateInstance(client, input.projectId, input.gateInstanceId)
  ]);
  if (!project || !gateInstance) {
    throw new GateSubmissionServiceError("GATE_INSTANCE_NOT_FOUND", "项目 Gate 实例不存在。", 404);
  }
  assertProjectWritable(project);
  if (
    input.expectedGateInstanceVersion !== undefined &&
    gateInstance.version !== input.expectedGateInstanceVersion
  ) {
    throw new GateSubmissionServiceError(
      "GATE_INSTANCE_VERSION_CONFLICT",
      "Gate 实例已变化，请刷新后重试。"
    );
  }
  if (gateInstance.checkRunSequence < 1) {
    throw new GateSubmissionServiceError(
      "GATE_CHECK_REQUIRED",
      "必须先完成当前 Gate 检查才能提交申请。"
    );
  }
  const checkSnapshot = await client.gateCheckSnapshot.findFirst({
    where: { gateInstanceId: gateInstance.id, sequence: gateInstance.checkRunSequence }
  });
  if (!checkSnapshot) {
    throw new GateSubmissionServiceError("GATE_CHECK_REQUIRED", "当前 Gate 检查结果不存在。");
  }
  if (checkSnapshot.status === "HARD_FAILED") {
    throw new GateSubmissionServiceError(
      "GATE_CHECK_HARD_FAILED",
      "当前 Gate 检查存在硬失败，不能提交申请。"
    );
  }
  const approval = parseGateApprovalConfiguration(gateInstance.gateDefinition.definitionJson);
  const activeMembers = await client.projectMember.findMany({
    where: {
      projectId: input.projectId,
      leftAt: null,
      user: { status: UserStatus.ACTIVE }
    },
    select: { id: true, userId: true, projectRole: true }
  });
  const approvers = resolveGateSubmissionApprovers({
    approverProjectRoles: approval.projectRoles,
    activeMembers: activeMembers.map((member) => ({
      membershipId: member.id,
      userId: member.userId,
      projectRole: member.projectRole
    }))
  });
  const pending = await client.gateSubmission.findFirst({
    where: { gateInstanceId: gateInstance.id, status: GateSubmissionStatus.PENDING },
    select: { id: true }
  });
  if (pending) {
    throw new GateSubmissionServiceError("GATE_SUBMISSION_PENDING", "该 Gate 已有待审申请。");
  }
  const nextSequence =
    (
      await client.gateSubmission.aggregate({
        where: { gateInstanceId: gateInstance.id },
        _max: { sequence: true }
      })
    )._max.sequence ?? 0;
  const now = await databaseNow(client);
  const submission = await client.gateSubmission.create({
    data: {
      projectId: input.projectId,
      gateInstanceId: gateInstance.id,
      gateCheckSnapshotId: checkSnapshot.id,
      previousSubmissionId: input.previousSubmissionId,
      sequence: nextSequence + 1,
      approvalMode: approval.mode,
      approverRolesJson: approval.projectRoles as Prisma.InputJsonValue,
      submittedReason: input.reason,
      submittedById: input.actorId,
      submittedAt: now
    }
  });
  await client.gateSubmissionApprover.createMany({
    data: approvers.map((approver) => ({
      projectId: input.projectId,
      gateSubmissionId: submission.id,
      userId: approver.userId,
      membershipIdsJson: approver.membershipIds as Prisma.InputJsonValue,
      projectRolesJson: approver.projectRoles as Prisma.InputJsonValue
    }))
  });
  try {
    await createGateSubmissionDocumentReferences({
      client,
      projectId: input.projectId,
      gateInstanceId: gateInstance.id,
      gateSubmissionId: submission.id
    });
  } catch (error) {
    if (error instanceof DocumentReviewError) {
      throw new GateSubmissionServiceError(error.code, error.message, error.status);
    }
    throw error;
  }
  const created = await client.gateSubmission.findUniqueOrThrow({
    where: { id: submission.id },
    include: submissionInclude
  });
  const snapshot = submissionSnapshot(created);
  const event = await appendSubmissionEvent(client, {
    submission: created,
    eventType: "SUBMITTED",
    reason: input.reason,
    actorId: input.actorId
  });
  const audit = await writeAudit(client, {
    action: AUDIT_ACTIONS.GATE_SUBMISSION_SUBMITTED,
    objectType: AUDIT_OBJECT_TYPES.GATE_SUBMISSION,
    objectId: created.id,
    context: auditContextFor(input, project, input.reason),
    after: { value: snapshot, allowedFields: GATE_SUBMISSION_AUDIT_FIELDS }
  });
  const outbox = await appendOutboxEvent(client, {
    eventType: "gate.submission.submitted",
    aggregateType: "GATE_SUBMISSION",
    aggregateId: created.id,
    idempotencyKey: created.id,
    payload: snapshot
  });
  return {
    submission: snapshot,
    resourceVersion: created.version,
    eventId: event.id,
    auditId: audit.id,
    outboxEventId: outbox.id
  };
}

export async function submitGateSubmission(
  input: {
    projectId: string;
    gateInstanceId: string;
    version: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const version = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  return inTransaction(transaction, (client) =>
    createSubmission(client, {
      ...input,
      reason,
      expectedGateInstanceVersion: version
    })
  );
}

export async function resubmitGateSubmission(
  input: {
    projectId: string;
    submissionId: string;
    version: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const version = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  return inTransaction(transaction, async (client) => {
    const previous = await lockSubmission(client, input.projectId, input.submissionId);
    if (!previous) {
      throw new GateSubmissionServiceError("GATE_SUBMISSION_NOT_FOUND", "Gate 申请不存在。", 404);
    }
    if (previous.version !== version) {
      throw new GateSubmissionServiceError(
        "GATE_SUBMISSION_VERSION_CONFLICT",
        "Gate 申请已变化，请刷新后重试。"
      );
    }
    if (
      previous.status !== GateSubmissionStatus.REJECTED &&
      previous.status !== GateSubmissionStatus.WITHDRAWN
    ) {
      throw new GateSubmissionServiceError(
        "GATE_SUBMISSION_RESUBMIT_INVALID",
        "仅被驳回或撤回的申请可以重提。"
      );
    }
    return createSubmission(client, {
      projectId: input.projectId,
      gateInstanceId: previous.gateInstanceId,
      previousSubmissionId: previous.id,
      actorId: input.actorId,
      reason,
      auditContext: input.auditContext
    });
  });
}

export async function withdrawGateSubmission(
  input: {
    projectId: string;
    submissionId: string;
    version: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const version = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  return inTransaction(transaction, async (client) => {
    const [project, current] = await Promise.all([
      client.project.findUnique({ where: { id: input.projectId } }),
      lockSubmission(client, input.projectId, input.submissionId)
    ]);
    if (!project || !current) {
      throw new GateSubmissionServiceError("GATE_SUBMISSION_NOT_FOUND", "Gate 申请不存在。", 404);
    }
    assertProjectWritable(project);
    if (current.submittedById !== input.actorId) {
      throw new GateSubmissionServiceError(
        "GATE_SUBMISSION_WITHDRAW_FORBIDDEN",
        "只有申请人可以撤回 Gate 申请。",
        403
      );
    }
    if (current.version !== version || current.status !== GateSubmissionStatus.PENDING) {
      throw new GateSubmissionServiceError(
        "GATE_SUBMISSION_VERSION_CONFLICT",
        "Gate 申请已变化，请刷新后重试。"
      );
    }
    const now = await databaseNow(client);
    const changed = await client.gateSubmission.updateMany({
      where: {
        id: current.id,
        projectId: input.projectId,
        version,
        status: GateSubmissionStatus.PENDING
      },
      data: {
        status: GateSubmissionStatus.WITHDRAWN,
        withdrawnById: input.actorId,
        withdrawnAt: now,
        withdrawalReason: reason,
        version: { increment: 1 }
      }
    });
    if (changed.count !== 1) {
      throw new GateSubmissionServiceError(
        "GATE_SUBMISSION_VERSION_CONFLICT",
        "Gate 申请已变化，请刷新后重试。"
      );
    }
    const updated = await client.gateSubmission.findUniqueOrThrow({
      where: { id: current.id },
      include: submissionInclude
    });
    const before = submissionSnapshot(current);
    const after = submissionSnapshot(updated);
    const event = await appendSubmissionEvent(client, {
      submission: updated,
      eventType: "WITHDRAWN",
      reason,
      actorId: input.actorId
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.GATE_SUBMISSION_WITHDRAWN,
      objectType: AUDIT_OBJECT_TYPES.GATE_SUBMISSION,
      objectId: updated.id,
      context: auditContextFor(input, project, reason),
      before: { value: before, allowedFields: GATE_SUBMISSION_AUDIT_FIELDS },
      after: { value: after, allowedFields: GATE_SUBMISSION_AUDIT_FIELDS }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "gate.submission.withdrawn",
      aggregateType: "GATE_SUBMISSION",
      aggregateId: updated.id,
      idempotencyKey: `${updated.id}:v${updated.version}`,
      payload: after
    });
    return {
      submission: after,
      resourceVersion: updated.version,
      eventId: event.id,
      auditId: audit.id,
      outboxEventId: outbox.id
    };
  });
}

export async function decideGateSubmission(
  input: {
    projectId: string;
    submissionId: string;
    version: number;
    decision: GateApprovalDecisionCode;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const version = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  return inTransaction(transaction, async (client) => {
    const [project, current] = await Promise.all([
      client.project.findUnique({ where: { id: input.projectId } }),
      lockSubmission(client, input.projectId, input.submissionId)
    ]);
    if (!project || !current) {
      throw new GateSubmissionServiceError("GATE_SUBMISSION_NOT_FOUND", "Gate 申请不存在。", 404);
    }
    assertProjectWritable(project);
    if (current.version !== version || current.status !== GateSubmissionStatus.PENDING) {
      throw new GateSubmissionServiceError(
        "GATE_SUBMISSION_VERSION_CONFLICT",
        "Gate 申请已变化，请刷新后重试。"
      );
    }
    const approver = current.approvers.find(({ userId }) => userId === input.actorId);
    if (!approver) {
      throw new GateSubmissionServiceError(
        "GATE_APPROVAL_FORBIDDEN",
        "当前用户不是该 Gate 申请的冻结审批人。",
        403
      );
    }
    if (current.approvals.some(({ decidedById }) => decidedById === input.actorId)) {
      throw new GateSubmissionServiceError(
        "GATE_APPROVAL_ALREADY_RECORDED",
        "当前审批人已经提交过审批意见。"
      );
    }
    const activeMembership = await client.projectMember.findFirst({
      where: {
        projectId: input.projectId,
        userId: input.actorId,
        leftAt: null,
        user: { status: UserStatus.ACTIVE }
      },
      select: { id: true }
    });
    if (!activeMembership) {
      throw new GateSubmissionServiceError(
        "GATE_APPROVER_NOT_ACTIVE",
        "当前审批人已不再是有效项目成员。",
        403
      );
    }
    const now = await databaseNow(client);
    const approval = await client.gateApproval.create({
      data: {
        projectId: input.projectId,
        gateSubmissionId: current.id,
        gateSubmissionApproverId: approver.id,
        decision: input.decision as GateApprovalDecision,
        reason,
        decidedById: input.actorId,
        decidedAt: now
      }
    });
    const nextStatus = evaluateGateSubmissionDecision({
      approvalMode: current.approvalMode as GateApprovalModeCode,
      approverUserIds: current.approvers.map(({ userId }) => userId),
      decisions: [
        ...current.approvals.map((existing) => ({
          userId: existing.decidedById,
          decision: existing.decision as GateApprovalDecisionCode
        })),
        { userId: input.actorId, decision: input.decision }
      ]
    });
    const changed = await client.gateSubmission.updateMany({
      where: {
        id: current.id,
        projectId: input.projectId,
        version,
        status: GateSubmissionStatus.PENDING
      },
      data: {
        status: nextStatus as GateSubmissionStatus,
        ...(nextStatus === "PENDING" ? {} : { decidedAt: now }),
        version: { increment: 1 }
      }
    });
    if (changed.count !== 1) {
      throw new GateSubmissionServiceError(
        "GATE_SUBMISSION_VERSION_CONFLICT",
        "Gate 申请已变化，请刷新后重试。"
      );
    }
    const updated = await client.gateSubmission.findUniqueOrThrow({
      where: { id: current.id },
      include: submissionInclude
    });
    const before = submissionSnapshot(current);
    const after = submissionSnapshot(updated);
    const approvalAudit = await writeAudit(client, {
      action: AUDIT_ACTIONS.GATE_APPROVAL_RECORDED,
      objectType: AUDIT_OBJECT_TYPES.GATE_APPROVAL,
      objectId: approval.id,
      context: auditContextFor(input, project, reason),
      after: {
        value: {
          projectId: updated.projectId,
          gateSubmissionId: updated.id,
          gateApprovalId: approval.id,
          gateSubmissionApproverId: approver.id,
          decision: approval.decision,
          decidedById: approval.decidedById,
          decidedAt: approval.decidedAt.toISOString(),
          status: updated.status,
          version: updated.version
        },
        allowedFields: GATE_APPROVAL_AUDIT_FIELDS
      }
    });
    const approvalOutbox = await appendOutboxEvent(client, {
      eventType: "gate.approval.recorded",
      aggregateType: "GATE_APPROVAL",
      aggregateId: approval.id,
      idempotencyKey: approval.id,
      payload: after
    });
    if (nextStatus === "PENDING") {
      return {
        submission: after,
        resourceVersion: updated.version,
        approvalId: approval.id,
        auditId: approvalAudit.id,
        outboxEventId: approvalOutbox.id
      };
    }
    const event = await appendSubmissionEvent(client, {
      submission: updated,
      eventType: nextStatus,
      reason,
      actorId: input.actorId
    });
    const audit = await writeAudit(client, {
      action:
        nextStatus === "APPROVED"
          ? AUDIT_ACTIONS.GATE_SUBMISSION_APPROVED
          : AUDIT_ACTIONS.GATE_SUBMISSION_REJECTED,
      objectType: AUDIT_OBJECT_TYPES.GATE_SUBMISSION,
      objectId: updated.id,
      context: auditContextFor(input, project, reason),
      before: { value: before, allowedFields: GATE_SUBMISSION_AUDIT_FIELDS },
      after: { value: after, allowedFields: GATE_SUBMISSION_AUDIT_FIELDS }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType:
        nextStatus === "APPROVED" ? "gate.submission.approved" : "gate.submission.rejected",
      aggregateType: "GATE_SUBMISSION",
      aggregateId: updated.id,
      idempotencyKey: `${updated.id}:v${updated.version}`,
      payload: after
    });
    return {
      submission: after,
      resourceVersion: updated.version,
      approvalId: approval.id,
      eventId: event.id,
      auditId: audit.id,
      outboxEventId: outbox.id
    };
  });
}

export async function findGateSubmissionApproverIds(projectId: string, submissionId: string) {
  const submission = await db.gateSubmission.findFirst({
    where: { id: submissionId, projectId },
    select: { approvers: { select: { userId: true } } }
  });
  return submission ? submission.approvers.map(({ userId }) => userId) : null;
}

export async function listGateSubmissions(projectId: string) {
  const submissions = await db.gateSubmission.findMany({
    where: { projectId },
    include: submissionInclude,
    orderBy: [{ gateInstanceId: "asc" }, { sequence: "desc" }]
  });
  return submissions.map(submissionSnapshot);
}
