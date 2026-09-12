import {
  PlanningChangeApprovalDecision,
  PlanningChangeApprovalMode,
  PlanningChangeClassification,
  PlanningChangeStatus,
  Prisma,
  UserStatus
} from "@prisma/client";

import { PROJECT_ROLE_VALUES, type ProjectRoleCode } from "@/lib/auth/permissions";
import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  PLANNING_CHANGE_APPROVAL_AUDIT_FIELDS,
  PLANNING_CHANGE_AUDIT_FIELDS,
  PLANNING_CHANGE_REVISION_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import type { JsonValue } from "@/modules/governance/domain/idempotency";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  buildPlanningChangeRevision,
  evaluatePlanningChangeDecision,
  PlanningChangeError,
  resolvePlanningChangeApprovers,
  requiredBaselineVersion,
  type PlanningChangeApprovalMode as PlanningChangeApprovalModeCode,
  type PlanningChangeClassification as PlanningChangeClassificationCode
} from "../domain/planning-change";

import { freezePlanningBaseline } from "./planning-baseline-service";

/** 变更单状态机：DRAFT → SUBMITTED → APPROVED / REJECTED。 */
export type PlanningChangeCommand = {
  projectId: string;
  actorId: string;
  auditContext: AuditContext;
};

export type PlanningChangeApprovalConfiguration = {
  mode: PlanningChangeApprovalModeCode;
  projectRoles: ProjectRoleCode[];
};

const changeInclude = {
  revisions: { orderBy: { revision: "asc" } },
  approvers: true,
  approvals: true
} satisfies Prisma.PlanningChangeInclude;

type PlanningChangeFact = Prisma.PlanningChangeGetPayload<{ include: typeof changeInclude }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : [];
}

/**
 * 审批配置以显式入参提供：审批人解析规则与 ALL/ANY 模式尚未由业务 Owner 定稿，
 * 领域不自行编造默认，缺省即拒绝。
 */
export function parsePlanningChangeApprovalConfiguration(
  value: unknown
): PlanningChangeApprovalConfiguration {
  if (!isRecord(value)) {
    throw new PlanningChangeError(
      "PLANNING_CHANGE_APPROVER_CONFIGURATION_MISSING",
      "计划变更未配置审批模式与审批项目角色。",
      422
    );
  }
  const { mode, projectRoles } = value;
  if ((mode !== "ALL" && mode !== "ANY") || !Array.isArray(projectRoles)) {
    throw new PlanningChangeError(
      "PLANNING_CHANGE_APPROVER_CONFIGURATION_INVALID",
      "计划变更审批配置无效。",
      422
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
    throw new PlanningChangeError(
      "PLANNING_CHANGE_APPROVER_CONFIGURATION_INVALID",
      "计划变更审批角色配置无效。",
      422
    );
  }
  return { mode, projectRoles: roles };
}

function commandReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new PlanningChangeError("REASON_REQUIRED", "操作原因必须是 1 到 1024 个字符。", 422);
  }
  return value.trim();
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PlanningChangeError("PLANNING_CHANGE_VERSION_INVALID", "version 必须是正整数。", 422);
  }
  return value as number;
}

function parseClassification(value: unknown): PlanningChangeClassificationCode {
  if (value !== "FORECAST_ONLY" && value !== "FORMAL") {
    throw new PlanningChangeError(
      "PLANNING_CHANGE_CLASSIFICATION_INVALID",
      "变更分类必须是 FORECAST_ONLY 或 FORMAL。",
      422
    );
  }
  return value;
}

function assertProjectWritable(project: {
  initializationStatus: string;
  structureStatus: string;
  status: string;
}) {
  if (project.initializationStatus !== "READY" || project.structureStatus !== "READY") {
    throw new PlanningChangeError(
      "PROJECT_STRUCTURE_NOT_READY",
      "项目模板和结构必须先完成初始化。"
    );
  }
  if (project.status === "CLOSED" || project.status === "CANCELED") {
    throw new PlanningChangeError("PROJECT_READ_ONLY", "已关闭项目不能变更计划。");
  }
}

function changeAuditValue(change: PlanningChangeFact) {
  const current = change.revisions.find((revision) => revision.id === change.currentRevisionId);
  return {
    id: change.id,
    projectId: change.projectId,
    planningChangeId: change.id,
    code: change.code,
    previousChangeId: change.previousChangeId,
    sequence: change.sequence,
    classification: change.classification,
    status: change.status,
    approvalMode: change.approvalMode,
    approverProjectRoles: change.approverRolesJson ? jsonStringArray(change.approverRolesJson) : [],
    currentRevisionId: change.currentRevisionId,
    currentRevision: current ? current.revision : null,
    currentRevisionChecksum: current ? current.checksum : null,
    resultingBaselineId: change.resultingBaselineId,
    submittedById: change.submittedById,
    submittedAt: change.submittedAt?.toISOString() ?? null,
    decidedAt: change.decidedAt?.toISOString() ?? null,
    version: change.version
  };
}

function revisionAuditValue(change: PlanningChangeFact, revisionId: string) {
  const revision = change.revisions.find((value) => value.id === revisionId);
  if (!revision) throw new Error("计划变更修订不存在。");
  return {
    projectId: revision.projectId,
    planningChangeId: revision.planningChangeId,
    planningChangeRevisionId: revision.id,
    revision: revision.revision,
    classification: revision.classification,
    reason: revision.reason,
    planningInputVersion: revision.planningInputVersion,
    resultingPlanningInputVersion: revision.resultingPlanningInputVersion,
    checksum: revision.checksum
  };
}

function auditContextFor(
  input: PlanningChangeCommand,
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

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

async function lockChange(
  client: Prisma.TransactionClient,
  projectId: string,
  changeId: string
): Promise<PlanningChangeFact | null> {
  await client.$queryRaw`
    SELECT "id" FROM "planning_changes"
    WHERE "id" = ${changeId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  return client.planningChange.findFirst({
    where: { id: changeId, projectId },
    include: changeInclude
  });
}

async function nextChangeSequence(
  client: Prisma.TransactionClient,
  projectId: string
): Promise<{ previousChangeId: string | null; sequence: number }> {
  const latest = await client.planningChange.findFirst({
    where: { projectId },
    orderBy: [{ sequence: "desc" }, { id: "desc" }],
    select: { id: true, sequence: true }
  });
  return { previousChangeId: latest?.id ?? null, sequence: (latest?.sequence ?? 0) + 1 };
}

function changeCode(sequence: number): string {
  return `PC-${String(sequence).padStart(4, "0")}`;
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new PlanningChangeError(
        "PLANNING_CHANGE_CONFLICT",
        "计划变更编号或修订号冲突，请刷新后重试。"
      );
    }
    if (error.code === "P2003" || error.code === "P2004") {
      throw new PlanningChangeError(
        "PLANNING_CHANGE_CONSTRAINT_VIOLATION",
        "计划变更未通过数据库约束（状态机、分类或审批关系）。"
      );
    }
  }
  throw error;
}

/**
 * 创建变更草稿。草稿可反复追加修订；一经提交，修订、分类与审批配置即冻结。
 * 普通延期（FORECAST_ONLY）只推进预测输入版本，永不绑定基线。
 */
export async function createPlanningChange(
  input: PlanningChangeCommand & {
    classification: PlanningChangeClassificationCode;
    reason: string;
    planningInputVersion: number;
    resultingPlanningInputVersion: number;
    delta: unknown;
  },
  transaction?: Prisma.TransactionClient
) {
  const classification = parseClassification(input.classification);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const project = await client.project.findUnique({ where: { id: input.projectId } });
      if (!project) {
        throw new PlanningChangeError("PROJECT_NOT_FOUND", "项目不存在。", 404);
      }
      assertProjectWritable(project);
      const { previousChangeId, sequence } = await nextChangeSequence(client, input.projectId);
      const change = await client.planningChange.create({
        data: {
          projectId: input.projectId,
          code: changeCode(sequence),
          previousChangeId,
          sequence,
          classification: classification as PlanningChangeClassification,
          createdById: input.actorId
        }
      });
      const revision = buildPlanningChangeRevision({
        revision: 1,
        classification,
        reason,
        planningInputVersion: input.planningInputVersion,
        resultingPlanningInputVersion: input.resultingPlanningInputVersion,
        delta: (input.delta ?? {}) as JsonValue
      });
      const createdRevision = await client.planningChangeRevision.create({
        data: {
          projectId: input.projectId,
          planningChangeId: change.id,
          revision: revision.revision,
          classification: revision.classification as PlanningChangeClassification,
          reason: revision.reason,
          planningInputVersion: revision.planningInputVersion,
          resultingPlanningInputVersion: revision.resultingPlanningInputVersion,
          deltaJson: revision.delta as Prisma.InputJsonValue,
          checksum: revision.checksum,
          createdById: input.actorId
        }
      });
      const updated = await client.planningChange.update({
        where: { id: change.id },
        data: { currentRevisionId: createdRevision.id },
        include: changeInclude
      });
      const auditValue = changeAuditValue(updated);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PLANNING_CHANGE_CREATED,
        objectType: AUDIT_OBJECT_TYPES.PLANNING_CHANGE,
        objectId: updated.id,
        context: auditContextFor(input, project, reason),
        after: { value: auditValue, allowedFields: PLANNING_CHANGE_AUDIT_FIELDS }
      });
      const revisionAudit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PLANNING_CHANGE_CREATED,
        objectType: AUDIT_OBJECT_TYPES.PLANNING_CHANGE_REVISION,
        objectId: createdRevision.id,
        context: auditContextFor(input, project, reason),
        after: {
          value: revisionAuditValue(updated, createdRevision.id),
          allowedFields: PLANNING_CHANGE_REVISION_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "planning.change.created",
        aggregateType: "PLANNING_CHANGE",
        aggregateId: updated.id,
        idempotencyKey: `${updated.id}:r1`,
        payload: auditValue
      });
      return {
        change: auditValue,
        revisionId: createdRevision.id,
        auditId: audit.id,
        revisionAuditId: revisionAudit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    if (error instanceof PlanningChangeError) throw error;
    mapDatabaseError(error);
  }
}

/**
 * 提交变更：冻结审批人快照并进入 SUBMITTED。
 * 提交后分类、审批模式与审批角色不可再改（数据库触发器二次兜底）。
 */
export async function submitPlanningChange(
  input: PlanningChangeCommand & {
    changeId: string;
    version: number;
    reason: string;
    approvalMode: PlanningChangeApprovalModeCode;
    approverProjectRoles: readonly string[];
  },
  transaction?: Prisma.TransactionClient
) {
  const version = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  const approval = parsePlanningChangeApprovalConfiguration({
    mode: input.approvalMode,
    projectRoles: input.approverProjectRoles
  });
  try {
    return await inTransaction(transaction, async (client) => {
      const project = await client.project.findUnique({ where: { id: input.projectId } });
      const current = await lockChange(client, input.projectId, input.changeId);
      if (!project || !current) {
        throw new PlanningChangeError("PLANNING_CHANGE_NOT_FOUND", "计划变更不存在。", 404);
      }
      assertProjectWritable(project);
      if (current.version !== version) {
        throw new PlanningChangeError(
          "PLANNING_CHANGE_VERSION_CONFLICT",
          "计划变更已变化，请刷新后重试。"
        );
      }
      if (current.status !== PlanningChangeStatus.DRAFT) {
        throw new PlanningChangeError(
          "PLANNING_CHANGE_SUBMIT_INVALID",
          "仅草稿状态的计划变更可以提交。"
        );
      }
      if (!current.currentRevisionId) {
        throw new PlanningChangeError(
          "PLANNING_CHANGE_REVISION_REQUIRED",
          "计划变更缺少当前修订。"
        );
      }
      const activeMembers = await client.projectMember.findMany({
        where: {
          projectId: input.projectId,
          leftAt: null,
          user: { status: UserStatus.ACTIVE }
        },
        select: { id: true, userId: true, projectRole: true }
      });
      const approvers = resolvePlanningChangeApprovers({
        approverProjectRoles: approval.projectRoles,
        activeMembers: activeMembers.map((member) => ({
          membershipId: member.id,
          userId: member.userId,
          projectRole: member.projectRole
        }))
      });
      const now = await databaseNow(client);
      const changed = await client.planningChange.updateMany({
        where: {
          id: current.id,
          projectId: input.projectId,
          version,
          status: PlanningChangeStatus.DRAFT
        },
        data: {
          status: PlanningChangeStatus.SUBMITTED,
          approvalMode: approval.mode as PlanningChangeApprovalMode,
          approverRolesJson: approval.projectRoles as Prisma.InputJsonValue,
          submittedReason: reason,
          submittedById: input.actorId,
          submittedAt: now,
          version: { increment: 1 }
        }
      });
      if (changed.count !== 1) {
        throw new PlanningChangeError(
          "PLANNING_CHANGE_VERSION_CONFLICT",
          "计划变更已变化，请刷新后重试。"
        );
      }
      await client.planningChangeApprover.createMany({
        data: approvers.map((approver) => ({
          projectId: input.projectId,
          planningChangeId: current.id,
          userId: approver.userId,
          membershipIdsJson: approver.membershipIds as Prisma.InputJsonValue,
          projectRolesJson: approver.projectRoles as Prisma.InputJsonValue
        }))
      });
      const updated = await client.planningChange.findUniqueOrThrow({
        where: { id: current.id },
        include: changeInclude
      });
      const auditValue = changeAuditValue(updated);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PLANNING_CHANGE_SUBMITTED,
        objectType: AUDIT_OBJECT_TYPES.PLANNING_CHANGE,
        objectId: updated.id,
        context: auditContextFor(input, project, reason),
        before: { value: changeAuditValue(current), allowedFields: PLANNING_CHANGE_AUDIT_FIELDS },
        after: { value: auditValue, allowedFields: PLANNING_CHANGE_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "planning.change.submitted",
        aggregateType: "PLANNING_CHANGE",
        aggregateId: updated.id,
        idempotencyKey: `${updated.id}:v${updated.version}`,
        payload: auditValue
      });
      return {
        change: auditValue,
        resourceVersion: updated.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    if (error instanceof PlanningChangeError) throw error;
    mapDatabaseError(error);
  }
}

/**
 * 记录一位冻结审批人的决策。ALL 会签需全员批准；ANY 或签任一人批准即通过；
 * 任一拒绝立即拒绝。批准 FORMAL 变更时同步生成基线 V2，V1 永久保留。
 */
export async function decidePlanningChange(
  input: PlanningChangeCommand & {
    changeId: string;
    version: number;
    decision: PlanningChangeApprovalDecision;
    reason: string;
  },
  transaction?: Prisma.TransactionClient
) {
  const version = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const project = await client.project.findUnique({ where: { id: input.projectId } });
      const current = await lockChange(client, input.projectId, input.changeId);
      if (!project || !current) {
        throw new PlanningChangeError("PLANNING_CHANGE_NOT_FOUND", "计划变更不存在。", 404);
      }
      assertProjectWritable(project);
      if (current.version !== version || current.status !== PlanningChangeStatus.SUBMITTED) {
        throw new PlanningChangeError(
          "PLANNING_CHANGE_VERSION_CONFLICT",
          "计划变更已变化，请刷新后重试。"
        );
      }
      const approver = current.approvers.find(({ userId }) => userId === input.actorId);
      if (!approver) {
        throw new PlanningChangeError(
          "PLANNING_CHANGE_APPROVAL_FORBIDDEN",
          "当前用户不是该计划变更的冻结审批人。",
          403
        );
      }
      if (current.approvals.some(({ decidedById }) => decidedById === input.actorId)) {
        throw new PlanningChangeError(
          "PLANNING_CHANGE_APPROVAL_ALREADY_RECORDED",
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
        throw new PlanningChangeError(
          "PLANNING_CHANGE_APPROVER_NOT_ACTIVE",
          "当前审批人已不再是有效项目成员。",
          403
        );
      }
      const now = await databaseNow(client);
      const approval = await client.planningChangeApproval.create({
        data: {
          projectId: input.projectId,
          planningChangeId: current.id,
          planningChangeApproverId: approver.id,
          decision: input.decision,
          reason,
          decidedById: input.actorId,
          decidedAt: now
        }
      });
      const nextStatus = evaluatePlanningChangeDecision({
        approvalMode: current.approvalMode as PlanningChangeApprovalModeCode,
        approverUserIds: current.approvers.map(({ userId }) => userId),
        decisions: [
          ...current.approvals.map((existing) => ({
            userId: existing.decidedById,
            decision: existing.decision as PlanningChangeApprovalDecision
          })),
          { userId: input.actorId, decision: input.decision }
        ]
      });
      const currentRevision = current.revisions.find(
        (revision) => revision.id === current.currentRevisionId
      );
      if (!currentRevision) {
        throw new PlanningChangeError(
          "PLANNING_CHANGE_REVISION_REQUIRED",
          "计划变更缺少当前修订。"
        );
      }
      // 正式变更批准后用变更生效后的预测输入版本冻结基线 V2；普通延期不生成基线。
      const baselineVersion = requiredBaselineVersion(
        current.classification as PlanningChangeClassificationCode
      );
      let resultingBaselineId: string | null = null;
      let baselineAuditId: string | null = null;
      let baselineOutboxEventId: string | null = null;
      if (nextStatus === "APPROVED" && baselineVersion === 2) {
        const frozen = await freezePlanningBaseline(
          {
            projectId: input.projectId,
            version: 2,
            planningInputVersion: currentRevision.resultingPlanningInputVersion,
            reason,
            actorId: input.actorId,
            auditContext: auditContextFor(input, project, reason)
          },
          client
        );
        resultingBaselineId = frozen.baseline.id;
        baselineAuditId = frozen.auditId;
        baselineOutboxEventId = frozen.outboxEventId;
      }
      const changed = await client.planningChange.updateMany({
        where: {
          id: current.id,
          projectId: input.projectId,
          version,
          status: PlanningChangeStatus.SUBMITTED
        },
        data: {
          status: nextStatus as PlanningChangeStatus,
          ...(nextStatus === "SUBMITTED" ? {} : { decidedAt: now }),
          ...(resultingBaselineId ? { resultingBaselineId } : {}),
          version: { increment: 1 }
        }
      });
      if (changed.count !== 1) {
        throw new PlanningChangeError(
          "PLANNING_CHANGE_VERSION_CONFLICT",
          "计划变更已变化，请刷新后重试。"
        );
      }
      const updated = await client.planningChange.findUniqueOrThrow({
        where: { id: current.id },
        include: changeInclude
      });
      const auditValue = changeAuditValue(updated);
      const approvalAudit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PLANNING_CHANGE_DECIDED,
        objectType: AUDIT_OBJECT_TYPES.PLANNING_CHANGE,
        objectId: updated.id,
        context: auditContextFor(input, project, reason),
        after: {
          value: {
            projectId: updated.projectId,
            planningChangeId: updated.id,
            planningChangeApprovalId: approval.id,
            planningChangeApproverId: approver.id,
            userId: approval.decidedById,
            decision: approval.decision,
            reason: approval.reason,
            decidedAt: approval.decidedAt.toISOString(),
            status: updated.status,
            version: updated.version
          },
          allowedFields: PLANNING_CHANGE_APPROVAL_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType:
          nextStatus === "APPROVED"
            ? "planning.change.approved"
            : nextStatus === "REJECTED"
              ? "planning.change.rejected"
              : "planning.change.approval.recorded",
        aggregateType: "PLANNING_CHANGE",
        aggregateId: updated.id,
        idempotencyKey: `${updated.id}:v${updated.version}`,
        payload: auditValue
      });
      if (nextStatus === "SUBMITTED") {
        return {
          change: auditValue,
          resourceVersion: updated.version,
          approvalId: approval.id,
          auditId: approvalAudit.id,
          outboxEventId: outbox.id,
          baselineId: null,
          baselineAuditId: null,
          baselineOutboxEventId: null
        };
      }
      return {
        change: auditValue,
        resourceVersion: updated.version,
        approvalId: approval.id,
        auditId: approvalAudit.id,
        outboxEventId: outbox.id,
        baselineId: resultingBaselineId,
        baselineAuditId,
        baselineOutboxEventId
      };
    });
  } catch (error) {
    if (error instanceof PlanningChangeError) throw error;
    mapDatabaseError(error);
  }
}

export async function findPlanningChangeApproverIds(projectId: string, changeId: string) {
  const change = await db.planningChange.findFirst({
    where: { id: changeId, projectId },
    select: { approvers: { select: { userId: true } } }
  });
  return change ? change.approvers.map(({ userId }) => userId) : null;
}

export async function listPlanningChanges(projectId: string) {
  const changes = await db.planningChange.findMany({
    where: { projectId },
    include: changeInclude,
    orderBy: [{ sequence: "desc" }]
  });
  return { changes: changes.map(changeAuditValue) };
}

export async function getPlanningChange(projectId: string, changeId: string) {
  const change = await db.planningChange.findFirst({
    where: { id: changeId, projectId },
    include: changeInclude
  });
  if (!change) {
    throw new PlanningChangeError("PLANNING_CHANGE_NOT_FOUND", "计划变更不存在。", 404);
  }
  return { change: changeAuditValue(change) };
}
