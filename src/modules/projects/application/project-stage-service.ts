import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  DELIVERY_UNIT_STAGE_AUDIT_FIELDS,
  PROJECT_STAGE_AUDIT_FIELDS,
  STAGE_RELEASE_AUTHORIZATION_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  ProjectStageError,
  type ProjectStageExecutionStatus,
  validateAdjacentStageRelease,
  validateStageTransition
} from "../domain/project-stage";

export type ProjectStageAction =
  "AUTHORIZE" | "START" | "AWAIT_GATE" | "COMPLETE" | "CONDITIONALLY_RELEASE" | "SKIP";

export function stageAllowedActions(status: ProjectStageExecutionStatus): ProjectStageAction[] {
  switch (status) {
    case "NOT_STARTED":
      return ["AUTHORIZE", "SKIP"];
    case "AUTHORIZED":
      return ["START", "SKIP"];
    case "IN_PROGRESS":
      return ["AWAIT_GATE"];
    case "AWAITING_GATE":
      return ["COMPLETE", "CONDITIONALLY_RELEASE"];
    case "CONDITIONALLY_RELEASED":
      return ["COMPLETE"];
    default:
      return [];
  }
}

export function requiresReleaseAuthorization(input: {
  isFirstStage: boolean;
  previousStageCompleted: boolean;
}): boolean {
  return !input.isFirstStage && !input.previousStageCompleted;
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProjectStageError("INVALID_VERSION", "version 必须是正整数。", 422);
  }
  return value as number;
}

function commandReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new ProjectStageError("REASON_REQUIRED", "操作原因必须是 1 到 1024 个字符。", 422);
  }
  return value.trim();
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

function assertProjectWritable(project: { initializationStatus: string; status: string }) {
  if (project.initializationStatus !== "READY") {
    throw new ProjectStageError("PROJECT_NOT_READY", "项目模板快照尚未准备完成。", 409);
  }
  if (project.status === "CLOSED" || project.status === "CANCELED") {
    throw new ProjectStageError("PROJECT_READ_ONLY", "已关闭项目不能推进阶段。", 409);
  }
}

function isCompletedStage(status: ProjectStageExecutionStatus): boolean {
  return status === "COMPLETED" || status === "CONDITIONALLY_RELEASED" || status === "SKIPPED";
}

function eventTypeFor(status: ProjectStageExecutionStatus) {
  switch (status) {
    case "AUTHORIZED":
      return "AUTHORIZED" as const;
    case "IN_PROGRESS":
      return "STARTED" as const;
    case "AWAITING_GATE":
      return "AWAITING_GATE" as const;
    case "COMPLETED":
      return "COMPLETED" as const;
    case "CONDITIONALLY_RELEASED":
      return "CONDITIONALLY_RELEASED" as const;
    case "SKIPPED":
      return "SKIPPED" as const;
    default:
      throw new ProjectStageError("STAGE_TRANSITION_INVALID", "目标阶段状态无效。");
  }
}

function stageSnapshot(value: {
  id: string;
  projectId: string;
  sourceSnapshotComponentId?: string | null;
  deliveryUnitId?: string | null;
  projectStageId?: string;
  code?: string;
  name?: string;
  description?: string | null;
  sequence?: number;
  status: ProjectStageExecutionStatus;
  exceptionalReason: string | null;
  statusChangedAt: Date;
  version: number;
}) {
  return {
    projectId: value.projectId,
    projectStageId: value.projectStageId ?? value.id,
    deliveryUnitStageId: value.deliveryUnitId ? value.id : undefined,
    deliveryUnitId: value.deliveryUnitId ?? undefined,
    sourceSnapshotComponentId: value.sourceSnapshotComponentId ?? undefined,
    code: value.code ?? undefined,
    name: value.name ?? undefined,
    description: value.description ?? undefined,
    sequence: value.sequence ?? undefined,
    status: value.status,
    exceptionalReason: value.exceptionalReason,
    statusChangedAt: value.statusChangedAt.toISOString(),
    version: value.version
  };
}

function releaseSnapshot(value: {
  id: string;
  projectId: string;
  scope: string;
  status: string;
  fromProjectStageId: string;
  toProjectStageId: string;
  deliveryUnitId: string | null;
  reason: string;
  authorizedById: string;
  authorizedAt: Date;
  revokedById: string | null;
  revokedAt: Date | null;
  revocationReason: string | null;
  version: number;
}) {
  return {
    projectId: value.projectId,
    stageReleaseAuthorizationId: value.id,
    scope: value.scope,
    status: value.status,
    fromProjectStageId: value.fromProjectStageId,
    toProjectStageId: value.toProjectStageId,
    deliveryUnitId: value.deliveryUnitId,
    reason: value.reason,
    authorizedById: value.authorizedById,
    authorizedAt: value.authorizedAt.toISOString(),
    revokedById: value.revokedById,
    revokedAt: value.revokedAt?.toISOString() ?? null,
    revocationReason: value.revocationReason,
    version: value.version
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

function mapDatabaseError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new ProjectStageError("STAGE_CONFLICT", "阶段事实或当前放行授权已存在。", 409);
    }
    if (error.code === "P2003" || error.code === "P2004") {
      throw new ProjectStageError("STAGE_RELATION_INVALID", "阶段对象关系未通过数据库约束。", 409);
    }
  }
  throw error;
}

export async function listProjectStages(projectId: string) {
  const [projectStages, deliveryUnitStages, releases] = await Promise.all([
    db.projectStage.findMany({ where: { projectId }, orderBy: { sequence: "asc" } }),
    db.deliveryUnitStage.findMany({
      where: { projectId },
      orderBy: [{ deliveryUnitId: "asc" }, { projectStageId: "asc" }]
    }),
    db.stageReleaseAuthorization.findMany({
      where: { projectId },
      orderBy: { authorizedAt: "desc" }
    })
  ]);
  return {
    projectStages: projectStages.map((stage) => ({
      ...stageSnapshot(stage),
      allowedActions: stageAllowedActions(stage.status)
    })),
    deliveryUnitStages: deliveryUnitStages.map((stage) => ({
      ...stageSnapshot({ ...stage, projectStageId: stage.projectStageId }),
      allowedActions: stageAllowedActions(stage.status)
    })),
    releases: releases.map(releaseSnapshot)
  };
}

async function assertStageMayBeAuthorized(
  client: Prisma.TransactionClient,
  input: {
    projectId: string;
    projectStageId: string;
    sequence: number;
    deliveryUnitId?: string;
  }
) {
  const previousStage = await client.projectStage.findFirst({
    where: { projectId: input.projectId, sequence: { lt: input.sequence } },
    orderBy: { sequence: "desc" }
  });
  if (!previousStage) return;

  const previousStatus = input.deliveryUnitId
    ? (
        await client.deliveryUnitStage.findFirst({
          where: {
            projectId: input.projectId,
            deliveryUnitId: input.deliveryUnitId,
            projectStageId: previousStage.id
          },
          select: { status: true }
        })
      )?.status
    : previousStage.status;
  const previousCompleted = previousStatus ? isCompletedStage(previousStatus) : false;
  if (
    !requiresReleaseAuthorization({
      isFirstStage: false,
      previousStageCompleted: previousCompleted
    })
  ) {
    return;
  }
  const release = await client.stageReleaseAuthorization.findFirst({
    where: {
      projectId: input.projectId,
      fromProjectStageId: previousStage.id,
      toProjectStageId: input.projectStageId,
      status: "ACTIVE",
      OR: input.deliveryUnitId
        ? [
            { scope: "PROJECT", deliveryUnitId: null },
            { scope: "DELIVERY_UNIT", deliveryUnitId: input.deliveryUnitId }
          ]
        : [{ scope: "PROJECT", deliveryUnitId: null }]
    },
    select: { id: true }
  });
  if (!release) {
    throw new ProjectStageError(
      "STAGE_RELEASE_REQUIRED",
      "前一阶段尚未完成，必须先取得相邻阶段放行授权。"
    );
  }
}

export async function transitionProjectStage(
  input: {
    projectId: string;
    stageId: string;
    deliveryUnitStageId?: string | null;
    toStatus: ProjectStageExecutionStatus;
    version: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const version = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const [project, projectStage] = await Promise.all([
        client.project.findUnique({ where: { id: input.projectId } }),
        client.projectStage.findFirst({ where: { id: input.stageId, projectId: input.projectId } })
      ]);
      if (!project || !projectStage) {
        throw new ProjectStageError("PROJECT_STAGE_NOT_FOUND", "项目阶段不存在。", 404);
      }
      assertProjectWritable(project);

      const current = input.deliveryUnitStageId
        ? await client.deliveryUnitStage.findFirst({
            where: {
              id: input.deliveryUnitStageId,
              projectId: input.projectId,
              projectStageId: projectStage.id
            }
          })
        : projectStage;
      if (!current) {
        throw new ProjectStageError("DELIVERY_UNIT_STAGE_NOT_FOUND", "交付单元阶段不存在。", 404);
      }
      const fromStatus = current.status as ProjectStageExecutionStatus;
      validateStageTransition(fromStatus, input.toStatus, reason);
      if (input.toStatus === "AUTHORIZED" || input.toStatus === "IN_PROGRESS") {
        const deliveryUnitId = input.deliveryUnitStageId
          ? (current as Prisma.DeliveryUnitStageGetPayload<Record<never, never>>).deliveryUnitId
          : undefined;
        await assertStageMayBeAuthorized(client, {
          projectId: input.projectId,
          projectStageId: projectStage.id,
          sequence: projectStage.sequence,
          ...(deliveryUnitId ? { deliveryUnitId } : {})
        });
      }
      const now = await databaseNow(client);
      const exceptionalReason =
        input.toStatus === "CONDITIONALLY_RELEASED" || input.toStatus === "SKIPPED" ? reason : null;
      const changed = input.deliveryUnitStageId
        ? await client.deliveryUnitStage.updateMany({
            where: {
              id: current.id,
              projectId: input.projectId,
              projectStageId: projectStage.id,
              version,
              status: current.status
            },
            data: {
              status: input.toStatus,
              exceptionalReason,
              statusChangedAt: now,
              version: { increment: 1 },
              updatedById: input.actorId
            }
          })
        : await client.projectStage.updateMany({
            where: { id: current.id, projectId: input.projectId, version, status: current.status },
            data: {
              status: input.toStatus,
              exceptionalReason,
              statusChangedAt: now,
              version: { increment: 1 },
              updatedById: input.actorId
            }
          });
      if (changed.count !== 1) {
        throw new ProjectStageError("VERSION_CONFLICT", "阶段已发生变化，请刷新后重试。", 409);
      }

      const updated = input.deliveryUnitStageId
        ? await client.deliveryUnitStage.findUniqueOrThrow({ where: { id: current.id } })
        : await client.projectStage.findUniqueOrThrow({ where: { id: current.id } });
      if (!input.deliveryUnitStageId) {
        const updatedProjectStage = updated as Prisma.ProjectStageGetPayload<Record<never, never>>;
        await client.project.update({
          where: { id: project.id },
          data: {
            mainControlStageId: updatedProjectStage.id,
            mainControlStageProjectId: project.id,
            mainControlStageCode: updatedProjectStage.code,
            mainControlStageStatus: updatedProjectStage.status,
            mainControlStageSequence: updatedProjectStage.sequence,
            mainControlStageUpdatedAt: updatedProjectStage.statusChangedAt
          }
        });
        const sequence =
          (await client.projectStageEvent.count({
            where: { projectStageId: updatedProjectStage.id }
          })) + 1;
        await client.projectStageEvent.create({
          data: {
            projectId: project.id,
            projectStageId: updatedProjectStage.id,
            sequence,
            eventType: eventTypeFor(input.toStatus),
            fromStatus,
            toStatus: updatedProjectStage.status,
            reason,
            snapshotJson: stageSnapshot(updatedProjectStage) as Prisma.InputJsonValue,
            actorId: input.actorId
          }
        });
      }
      const snapshot = input.deliveryUnitStageId
        ? stageSnapshot({ ...updated, projectStageId: projectStage.id })
        : stageSnapshot(updated);
      const audit = await writeAudit(client, {
        action: input.deliveryUnitStageId
          ? AUDIT_ACTIONS.DELIVERY_UNIT_STAGE_UPDATED
          : AUDIT_ACTIONS.PROJECT_STAGE_UPDATED,
        objectType: input.deliveryUnitStageId
          ? AUDIT_OBJECT_TYPES.DELIVERY_UNIT_STAGE
          : AUDIT_OBJECT_TYPES.PROJECT_STAGE,
        objectId: updated.id,
        context: auditContextFor(input, project, reason),
        before: {
          value: input.deliveryUnitStageId
            ? stageSnapshot({ ...current, projectStageId: projectStage.id })
            : stageSnapshot(current),
          allowedFields: input.deliveryUnitStageId
            ? DELIVERY_UNIT_STAGE_AUDIT_FIELDS
            : PROJECT_STAGE_AUDIT_FIELDS
        },
        after: {
          value: snapshot,
          allowedFields: input.deliveryUnitStageId
            ? DELIVERY_UNIT_STAGE_AUDIT_FIELDS
            : PROJECT_STAGE_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: input.deliveryUnitStageId
          ? "project.delivery-unit-stage.updated"
          : "project.stage.updated",
        aggregateType: input.deliveryUnitStageId ? "DELIVERY_UNIT_STAGE" : "PROJECT_STAGE",
        aggregateId: updated.id,
        idempotencyKey: `${updated.id}:v${updated.version}`,
        payload: snapshot
      });
      return {
        stage: { ...snapshot, allowedActions: stageAllowedActions(updated.status) },
        resourceVersion: updated.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    if (error instanceof ProjectStageError) throw error;
    mapDatabaseError(error);
  }
}

export async function authorizeStageRelease(
  input: {
    projectId: string;
    scope: "PROJECT" | "DELIVERY_UNIT";
    fromStageId: string;
    toStageId: string;
    deliveryUnitId?: string | null;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const [project, fromStage, toStage, deliveryUnit] = await Promise.all([
        client.project.findUnique({ where: { id: input.projectId } }),
        client.projectStage.findFirst({
          where: { id: input.fromStageId, projectId: input.projectId }
        }),
        client.projectStage.findFirst({
          where: { id: input.toStageId, projectId: input.projectId }
        }),
        input.deliveryUnitId
          ? client.deliveryUnit.findFirst({
              where: { id: input.deliveryUnitId, projectId: input.projectId },
              select: { id: true }
            })
          : null
      ]);
      if (!project || !fromStage || !toStage) {
        throw new ProjectStageError("PROJECT_STAGE_NOT_FOUND", "项目阶段不存在。", 404);
      }
      assertProjectWritable(project);
      if (
        (input.scope === "PROJECT" && input.deliveryUnitId) ||
        (input.scope === "DELIVERY_UNIT" && (!input.deliveryUnitId || !deliveryUnit))
      ) {
        throw new ProjectStageError(
          "STAGE_RELEASE_SCOPE_INVALID",
          "放行范围与交付单元不匹配。",
          422
        );
      }
      validateAdjacentStageRelease({ projectId: project.id, fromStage, nextStage: toStage });
      const release = await client.stageReleaseAuthorization.create({
        data: {
          projectId: project.id,
          scope: input.scope,
          fromProjectStageId: fromStage.id,
          toProjectStageId: toStage.id,
          deliveryUnitId: input.deliveryUnitId ?? null,
          reason,
          authorizedById: input.actorId
        }
      });
      const snapshot = releaseSnapshot(release);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.STAGE_RELEASE_AUTHORIZED,
        objectType: AUDIT_OBJECT_TYPES.STAGE_RELEASE_AUTHORIZATION,
        objectId: release.id,
        context: auditContextFor(input, project, reason),
        after: { value: snapshot, allowedFields: STAGE_RELEASE_AUTHORIZATION_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "project.stage-release.authorized",
        aggregateType: "STAGE_RELEASE_AUTHORIZATION",
        aggregateId: release.id,
        idempotencyKey: `${release.id}:v${release.version}`,
        payload: snapshot
      });
      return {
        release: snapshot,
        resourceVersion: release.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    if (error instanceof ProjectStageError) throw error;
    mapDatabaseError(error);
  }
}

export async function revokeStageRelease(
  input: {
    projectId: string;
    releaseId: string;
    version: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const version = positiveVersion(input.version);
  const reason = commandReason(input.reason);
  try {
    return await inTransaction(transaction, async (client) => {
      const [project, current] = await Promise.all([
        client.project.findUnique({ where: { id: input.projectId } }),
        client.stageReleaseAuthorization.findFirst({
          where: { id: input.releaseId, projectId: input.projectId }
        })
      ]);
      if (!project || !current) {
        throw new ProjectStageError("STAGE_RELEASE_NOT_FOUND", "阶段放行不存在。", 404);
      }
      assertProjectWritable(project);
      const changed = await client.stageReleaseAuthorization.updateMany({
        where: { id: current.id, projectId: project.id, version, status: "ACTIVE" },
        data: {
          status: "REVOKED",
          revokedById: input.actorId,
          revokedAt: await databaseNow(client),
          revocationReason: reason,
          version: { increment: 1 }
        }
      });
      if (changed.count !== 1) {
        throw new ProjectStageError("VERSION_CONFLICT", "阶段放行已发生变化，请刷新后重试。", 409);
      }
      const release = await client.stageReleaseAuthorization.findUniqueOrThrow({
        where: { id: current.id }
      });
      const before = releaseSnapshot(current);
      const after = releaseSnapshot(release);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.STAGE_RELEASE_REVOKED,
        objectType: AUDIT_OBJECT_TYPES.STAGE_RELEASE_AUTHORIZATION,
        objectId: release.id,
        context: auditContextFor(input, project, reason),
        before: { value: before, allowedFields: STAGE_RELEASE_AUTHORIZATION_AUDIT_FIELDS },
        after: { value: after, allowedFields: STAGE_RELEASE_AUTHORIZATION_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "project.stage-release.revoked",
        aggregateType: "STAGE_RELEASE_AUTHORIZATION",
        aggregateId: release.id,
        idempotencyKey: `${release.id}:v${release.version}`,
        payload: after
      });
      return {
        release: after,
        resourceVersion: release.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    if (error instanceof ProjectStageError) throw error;
    mapDatabaseError(error);
  }
}
