import { GateSubmissionStatus, Prisma, UserStatus } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  GATE_CONDITIONAL_RELEASE_AUDIT_FIELDS,
  RESIDUAL_ITEM_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import {
  completeProjectStageAfterConditionalRelease,
  conditionallyReleaseProjectStage
} from "@/modules/projects/application/project-stage-service";
import { ProjectStageError } from "@/modules/projects/domain/project-stage";

import {
  GateConditionalReleaseError,
  nextResidualStatus,
  validateConditionalReleaseEligibility,
  validateResidualItemInput,
  type ResidualItemAction,
  type ResidualItemInput,
  type ResidualItemStatus
} from "../domain/gate-conditional-release";
import { appendOutboxEvent } from "../infrastructure/outbox";

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new GateConditionalReleaseError(
      "RESIDUAL_VERSION_INVALID",
      "version 必须是正整数。",
      422
    );
  }
  return value as number;
}

function commandReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new GateConditionalReleaseError(
      "RESIDUAL_REASON_REQUIRED",
      "操作原因必须是 1 到 1024 个字符。",
      422
    );
  }
  return value.trim();
}

function assertProjectWritable(project: { initializationStatus: string; status: string }) {
  if (project.initializationStatus !== "READY") {
    throw new GateConditionalReleaseError("GATE_PROJECT_NOT_READY", "项目模板快照尚未准备完成。");
  }
  if (project.status === "CLOSED" || project.status === "CANCELED") {
    throw new GateConditionalReleaseError(
      "GATE_PROJECT_READ_ONLY",
      "已关闭或取消项目不能条件放行或处理遗留项。"
    );
  }
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

function conditionalReleaseSnapshot(value: {
  id: string;
  projectId: string;
  gateSubmissionId: string;
  gateInstanceId: string;
  projectStageId: string;
  deliveryUnitStageId: string | null;
  releaseReason: string;
  releasedById: string;
  releasedAt: Date;
  version: number;
}) {
  return {
    projectId: value.projectId,
    gateConditionalReleaseId: value.id,
    gateSubmissionId: value.gateSubmissionId,
    gateInstanceId: value.gateInstanceId,
    projectStageId: value.projectStageId,
    deliveryUnitStageId: value.deliveryUnitStageId,
    releaseReason: value.releaseReason,
    releasedById: value.releasedById,
    releasedAt: value.releasedAt.toISOString(),
    version: value.version
  };
}

function residualItemSnapshot(value: {
  id: string;
  projectId: string;
  conditionalReleaseId: string;
  sequence: number;
  title: string;
  ownerMembershipId: string;
  verifierMembershipId: string;
  dueAt: Date;
  evidence: string;
  escalationRule: string;
  status: string;
  version: number;
}) {
  return {
    projectId: value.projectId,
    residualItemId: value.id,
    conditionalReleaseId: value.conditionalReleaseId,
    sequence: value.sequence,
    title: value.title,
    ownerMembershipId: value.ownerMembershipId,
    verifierMembershipId: value.verifierMembershipId,
    dueAt: value.dueAt.toISOString(),
    evidence: value.evidence,
    escalationRule: value.escalationRule,
    status: value.status,
    version: value.version
  };
}

function residualEventDetails(action: ResidualItemAction) {
  switch (action) {
    case "START":
      return {
        eventType: "STARTED" as const,
        auditAction: AUDIT_ACTIONS.RESIDUAL_ITEM_STARTED,
        outboxEventType: "gate.residual-item.started"
      };
    case "SUBMIT_VERIFICATION":
      return {
        eventType: "VERIFICATION_SUBMITTED" as const,
        auditAction: AUDIT_ACTIONS.RESIDUAL_ITEM_VERIFICATION_SUBMITTED,
        outboxEventType: "gate.residual-item.verification-submitted"
      };
    case "VERIFY":
      return {
        eventType: "VERIFIED" as const,
        auditAction: AUDIT_ACTIONS.RESIDUAL_ITEM_VERIFIED,
        outboxEventType: "gate.residual-item.verified"
      };
    case "RETURN":
      return {
        eventType: "RETURNED" as const,
        auditAction: AUDIT_ACTIONS.RESIDUAL_ITEM_RETURNED,
        outboxEventType: "gate.residual-item.returned"
      };
  }
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new GateConditionalReleaseError(
        "GATE_CONDITIONAL_RELEASE_CONFLICT",
        "Gate 条件放行或遗留项事实已存在，请刷新后重试。"
      );
    }
    if (error.code === "P2003" || error.code === "P2004") {
      throw new GateConditionalReleaseError(
        "GATE_CONDITIONAL_RELEASE_RELATION_INVALID",
        "条件放行对象关系未通过数据库约束。"
      );
    }
  }
  if (error instanceof ProjectStageError) {
    throw new GateConditionalReleaseError(error.code, error.message, error.status);
  }
  throw error;
}

async function lockGateSubmission(
  client: Prisma.TransactionClient,
  projectId: string,
  submissionId: string
) {
  await client.$queryRaw`
    SELECT "id" FROM "gate_submissions"
    WHERE "id" = ${submissionId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  return client.gateSubmission.findFirst({
    where: { id: submissionId, projectId },
    include: {
      approvers: true,
      gateInstance: true,
      gateCheckSnapshot: { include: { results: true } }
    }
  });
}

async function lockResidualItem(
  client: Prisma.TransactionClient,
  projectId: string,
  residualItemId: string
) {
  await client.$queryRaw`
    SELECT "id" FROM "residual_items"
    WHERE "id" = ${residualItemId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  return client.residualItem.findFirst({
    where: { id: residualItemId, projectId },
    include: {
      ownerMembership: { include: { user: true } },
      verifierMembership: { include: { user: true } },
      conditionalRelease: true
    }
  });
}

async function lockConditionalRelease(
  client: Prisma.TransactionClient,
  projectId: string,
  conditionalReleaseId: string
) {
  await client.$queryRaw`
    SELECT "id" FROM "gate_conditional_releases"
    WHERE "id" = ${conditionalReleaseId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  return client.gateConditionalRelease.findFirst({
    where: { id: conditionalReleaseId, projectId }
  });
}

async function assertActiveResidualMembers(
  client: Prisma.TransactionClient,
  projectId: string,
  inputs: readonly ResidualItemInput[]
) {
  const membershipIds = [
    ...new Set(inputs.flatMap((item) => [item.ownerMembershipId, item.verifierMembershipId]))
  ];
  const active = await client.projectMember.findMany({
    where: {
      id: { in: membershipIds },
      projectId,
      leftAt: null,
      user: { status: UserStatus.ACTIVE }
    },
    select: { id: true }
  });
  if (active.length !== membershipIds.length) {
    throw new GateConditionalReleaseError(
      "RESIDUAL_MEMBER_INVALID",
      "遗留项 Owner 和验证人必须是当前项目的有效成员。",
      422
    );
  }
}

export async function conditionallyReleaseGate(
  input: {
    projectId: string;
    submissionId: string;
    version: number;
    reason: string;
    residualItems: ResidualItemInput[];
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const version = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  if (
    !Array.isArray(input.residualItems) ||
    input.residualItems.length < 1 ||
    input.residualItems.length > 100
  ) {
    throw new GateConditionalReleaseError(
      "RESIDUAL_ITEMS_REQUIRED",
      "条件放行必须创建 1 到 100 条遗留项。",
      422
    );
  }
  const residualInputs = input.residualItems.map(validateResidualItemInput);
  try {
    return await inTransaction(transaction, async (client) => {
      const [project, submission] = await Promise.all([
        client.project.findUnique({ where: { id: input.projectId } }),
        lockGateSubmission(client, input.projectId, input.submissionId)
      ]);
      if (!project || !submission) {
        throw new GateConditionalReleaseError(
          "GATE_SUBMISSION_NOT_FOUND",
          "Gate 申请不存在。",
          404
        );
      }
      assertProjectWritable(project);
      if (submission.version !== version) {
        throw new GateConditionalReleaseError(
          "GATE_SUBMISSION_VERSION_CONFLICT",
          "Gate 申请已变化，请刷新后重试。"
        );
      }
      const actorMembership = await client.projectMember.findFirst({
        where: {
          projectId: input.projectId,
          userId: input.actorId,
          leftAt: null,
          user: { status: UserStatus.ACTIVE }
        },
        select: { id: true }
      });
      const targetStage =
        submission.gateInstance.scope === "PROJECT"
          ? await client.projectStage.findFirst({
              where: {
                id: submission.gateInstance.projectStageId,
                projectId: input.projectId
              }
            })
          : await client.deliveryUnitStage.findFirst({
              where: {
                projectId: input.projectId,
                projectStageId: submission.gateInstance.projectStageId,
                deliveryUnitId: submission.gateInstance.deliveryUnitId ?? undefined
              }
            });
      if (!targetStage) {
        throw new GateConditionalReleaseError(
          "GATE_CONDITIONAL_RELEASE_STAGE_NOT_FOUND",
          "Gate 对应的阶段不存在。",
          409
        );
      }
      validateConditionalReleaseEligibility({
        submissionStatus: submission.status,
        hasHardFailedCheck: submission.gateCheckSnapshot.results.some(
          (result) => result.status === "HARD_FAILED"
        ),
        actorIsFrozenApprover: submission.approvers.some(
          (approver) => approver.userId === input.actorId
        ),
        actorIsActiveProjectMember: Boolean(actorMembership),
        targetStageStatus: targetStage.status
      });
      await assertActiveResidualMembers(client, input.projectId, residualInputs);
      const release = await client.gateConditionalRelease.create({
        data: {
          projectId: input.projectId,
          gateSubmissionId: submission.id,
          gateInstanceId: submission.gateInstanceId,
          projectStageId: submission.gateInstance.projectStageId,
          deliveryUnitStageId: submission.gateInstance.scope === "PROJECT" ? null : targetStage.id,
          releaseReason: reason,
          releasedById: input.actorId
        }
      });
      const stage = await conditionallyReleaseProjectStage(
        {
          projectId: input.projectId,
          stageId: submission.gateInstance.projectStageId,
          deliveryUnitStageId:
            submission.gateInstance.scope === "PROJECT" ? undefined : targetStage.id,
          version: targetStage.version,
          reason,
          actorId: input.actorId,
          auditContext: auditContextFor(input, project, reason),
          gateConditionalReleaseId: release.id
        },
        client
      );
      const residualItems = [];
      for (const [position, residualInput] of residualInputs.entries()) {
        const residualItem = await client.residualItem.create({
          data: {
            projectId: input.projectId,
            conditionalReleaseId: release.id,
            sequence: position + 1,
            title: residualInput.title,
            ownerMembershipId: residualInput.ownerMembershipId,
            verifierMembershipId: residualInput.verifierMembershipId,
            dueAt: residualInput.dueAt,
            evidence: residualInput.evidence,
            escalationRule: residualInput.escalationRule
          }
        });
        const snapshot = residualItemSnapshot(residualItem);
        await client.residualItemEvent.create({
          data: {
            projectId: input.projectId,
            residualItemId: residualItem.id,
            sequence: 1,
            eventType: "CREATED",
            reason,
            snapshotJson: snapshot as Prisma.InputJsonValue,
            actorId: input.actorId
          }
        });
        await writeAudit(client, {
          action: AUDIT_ACTIONS.RESIDUAL_ITEM_CREATED,
          objectType: AUDIT_OBJECT_TYPES.RESIDUAL_ITEM,
          objectId: residualItem.id,
          context: auditContextFor(input, project, reason),
          after: { value: snapshot, allowedFields: RESIDUAL_ITEM_AUDIT_FIELDS }
        });
        await appendOutboxEvent(client, {
          eventType: "gate.residual-item.created",
          aggregateType: "RESIDUAL_ITEM",
          aggregateId: residualItem.id,
          idempotencyKey: `${release.id}:${residualItem.sequence}:created`,
          payload: snapshot
        });
        residualItems.push(snapshot);
      }
      const releaseSnapshot = conditionalReleaseSnapshot(release);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.GATE_CONDITIONALLY_RELEASED,
        objectType: AUDIT_OBJECT_TYPES.GATE_CONDITIONAL_RELEASE,
        objectId: release.id,
        context: auditContextFor(input, project, reason),
        after: { value: releaseSnapshot, allowedFields: GATE_CONDITIONAL_RELEASE_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "gate.conditionally-released",
        aggregateType: "GATE_CONDITIONAL_RELEASE",
        aggregateId: release.id,
        idempotencyKey: release.id,
        payload: { release: releaseSnapshot, residualItems }
      });
      return {
        release: releaseSnapshot,
        residualItems,
        stage: stage.stage,
        resourceVersion: release.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    if (error instanceof GateConditionalReleaseError) throw error;
    mapDatabaseError(error);
  }
}

async function completeConditionalReleaseStage(
  client: Prisma.TransactionClient,
  input: {
    projectId: string;
    actorId: string;
    auditContext: AuditContext;
    reason: string;
    release: { projectStageId: string; deliveryUnitStageId: string | null };
  }
) {
  const targetStage = input.release.deliveryUnitStageId
    ? await client.deliveryUnitStage.findFirst({
        where: { id: input.release.deliveryUnitStageId, projectId: input.projectId }
      })
    : await client.projectStage.findFirst({
        where: { id: input.release.projectStageId, projectId: input.projectId }
      });
  if (!targetStage) {
    throw new GateConditionalReleaseError(
      "GATE_CONDITIONAL_RELEASE_STAGE_NOT_FOUND",
      "条件放行对应的阶段不存在。",
      409
    );
  }
  return completeProjectStageAfterConditionalRelease(
    {
      projectId: input.projectId,
      stageId: input.release.projectStageId,
      deliveryUnitStageId: input.release.deliveryUnitStageId,
      version: targetStage.version,
      reason: `全部遗留项已由验证人关闭：${input.reason}`,
      actorId: input.actorId,
      auditContext: input.auditContext
    },
    client
  );
}

async function changeResidualItem(
  input: {
    projectId: string;
    residualItemId: string;
    version: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  action: ResidualItemAction,
  transaction?: Prisma.TransactionClient
) {
  const version = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const [project, current] = await Promise.all([
        client.project.findUnique({ where: { id: input.projectId } }),
        lockResidualItem(client, input.projectId, input.residualItemId)
      ]);
      if (!project || !current) {
        throw new GateConditionalReleaseError("RESIDUAL_ITEM_NOT_FOUND", "遗留项不存在。", 404);
      }
      assertProjectWritable(project);
      const conditionalRelease = await lockConditionalRelease(
        client,
        input.projectId,
        current.conditionalReleaseId
      );
      if (!conditionalRelease) {
        throw new GateConditionalReleaseError(
          "GATE_CONDITIONAL_RELEASE_NOT_FOUND",
          "条件放行记录不存在。",
          409
        );
      }
      const actorIsOwner =
        current.ownerMembership.userId === input.actorId &&
        current.ownerMembership.leftAt === null &&
        current.ownerMembership.user.status === UserStatus.ACTIVE;
      const actorIsVerifier =
        current.verifierMembership.userId === input.actorId &&
        current.verifierMembership.leftAt === null &&
        current.verifierMembership.user.status === UserStatus.ACTIVE;
      if ((action === "START" || action === "SUBMIT_VERIFICATION") && !actorIsOwner) {
        throw new GateConditionalReleaseError(
          "RESIDUAL_OWNER_FORBIDDEN",
          "只有当前有效的遗留项 Owner 可以处理或提交验证。",
          403
        );
      }
      if ((action === "VERIFY" || action === "RETURN") && !actorIsVerifier) {
        throw new GateConditionalReleaseError(
          "RESIDUAL_VERIFIER_FORBIDDEN",
          "只有当前有效的遗留项验证人可以关闭或退回。",
          403
        );
      }
      if (current.version !== version) {
        throw new GateConditionalReleaseError(
          "RESIDUAL_ITEM_VERSION_CONFLICT",
          "遗留项已变化，请刷新后重试。"
        );
      }
      const nextStatus = nextResidualStatus(current.status as ResidualItemStatus, action);
      const changed = await client.residualItem.updateMany({
        where: {
          id: current.id,
          projectId: input.projectId,
          version,
          status: current.status
        },
        data: { status: nextStatus, version: { increment: 1 } }
      });
      if (changed.count !== 1) {
        throw new GateConditionalReleaseError(
          "RESIDUAL_ITEM_VERSION_CONFLICT",
          "遗留项已变化，请刷新后重试。"
        );
      }
      const updated = await client.residualItem.findUniqueOrThrow({ where: { id: current.id } });
      const snapshot = residualItemSnapshot(updated);
      const eventDetails = residualEventDetails(action);
      const sequence =
        (await client.residualItemEvent.count({ where: { residualItemId: updated.id } })) + 1;
      await client.residualItemEvent.create({
        data: {
          projectId: input.projectId,
          residualItemId: updated.id,
          sequence,
          eventType: eventDetails.eventType,
          reason,
          snapshotJson: snapshot as Prisma.InputJsonValue,
          actorId: input.actorId
        }
      });
      const audit = await writeAudit(client, {
        action: eventDetails.auditAction,
        objectType: AUDIT_OBJECT_TYPES.RESIDUAL_ITEM,
        objectId: updated.id,
        context: auditContextFor(input, project, reason),
        before: {
          value: residualItemSnapshot(current),
          allowedFields: RESIDUAL_ITEM_AUDIT_FIELDS
        },
        after: { value: snapshot, allowedFields: RESIDUAL_ITEM_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: eventDetails.outboxEventType,
        aggregateType: "RESIDUAL_ITEM",
        aggregateId: updated.id,
        idempotencyKey: `${updated.id}:v${updated.version}`,
        payload: snapshot
      });
      let stage:
        Awaited<ReturnType<typeof completeProjectStageAfterConditionalRelease>>["stage"] | null =
        null;
      if (action === "VERIFY" && nextStatus === "CLOSED") {
        const remaining = await client.residualItem.count({
          where: {
            conditionalReleaseId: current.conditionalReleaseId,
            status: { not: "CLOSED" }
          }
        });
        if (remaining === 0) {
          const completed = await completeConditionalReleaseStage(client, {
            projectId: input.projectId,
            actorId: input.actorId,
            auditContext: auditContextFor(input, project, reason),
            reason,
            release: conditionalRelease
          });
          stage = completed.stage;
        }
      }
      return {
        residualItem: snapshot,
        stage,
        resourceVersion: updated.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    if (error instanceof GateConditionalReleaseError) throw error;
    mapDatabaseError(error);
  }
}

export async function startResidualItem(
  input: {
    projectId: string;
    residualItemId: string;
    version: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  return changeResidualItem(input, "START", transaction);
}

export async function submitResidualItemVerification(
  input: {
    projectId: string;
    residualItemId: string;
    version: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  return changeResidualItem(input, "SUBMIT_VERIFICATION", transaction);
}

export async function verifyResidualItem(
  input: {
    projectId: string;
    residualItemId: string;
    version: number;
    decision: "VERIFY" | "RETURN";
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  return changeResidualItem(input, input.decision, transaction);
}

export async function findResidualItemParticipantIds(projectId: string, residualItemId: string) {
  const residualItem = await db.residualItem.findFirst({
    where: { id: residualItemId, projectId },
    include: {
      ownerMembership: { select: { userId: true } },
      verifierMembership: { select: { userId: true } }
    }
  });
  return residualItem
    ? {
        ownerUserId: residualItem.ownerMembership.userId,
        verifierUserId: residualItem.verifierMembership.userId
      }
    : null;
}
