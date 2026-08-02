import { JobStatus, Prisma } from "@prisma/client";

import { decideAuthorization, type AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_RESULTS,
  AUTHORIZATION_DENIAL_AUDIT_FIELDS,
  JOB_REPLAY_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";

export class ReplayJobError extends Error {
  constructor(
    readonly code: "FORBIDDEN" | "REASON_REQUIRED" | "JOB_NOT_FOUND" | "INVALID_JOB_STATE",
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function replayReason(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ReplayJobError("REASON_REQUIRED", "人工重放必须填写原因。", 422);
  }
  return value.trim().slice(0, 1024);
}

async function databaseNow(transaction: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await transaction.$queryRaw<{ now: Date }[]>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) {
    throw new Error("无法读取数据库时间。");
  }
  return clock.now;
}

export async function replayDeadLetterJob(
  input: {
    jobId: string;
    actor: AuthorizationActor;
    reason: unknown;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const decision = decideAuthorization(input.actor, PERMISSIONS.JOB_REPLAY);
  if (!decision.allowed) {
    await writeAudit(db, {
      action: AUDIT_ACTIONS.AUTHORIZATION_DENIED,
      objectType: AUDIT_OBJECT_TYPES.PERSISTENT_JOB,
      objectId: input.jobId,
      result: AUDIT_RESULTS.DENIED,
      context: { ...input.auditContext, actorId: input.actor.id, reason: decision.reason },
      metadata: {
        value: { permission: PERMISSIONS.JOB_REPLAY, method: "APPLICATION", path: "job.replay" },
        allowedFields: AUTHORIZATION_DENIAL_AUDIT_FIELDS
      }
    });
    throw new ReplayJobError("FORBIDDEN", "当前角色无权重放持久作业。", 403);
  }

  const reason = replayReason(input.reason);
  return inTransaction(transaction, async (client) => {
    const now = await databaseNow(client);
    const job = await client.persistentJob.findUnique({ where: { id: input.jobId } });
    if (!job) {
      throw new ReplayJobError("JOB_NOT_FOUND", "持久作业不存在。", 404);
    }

    const changed = await client.persistentJob.updateMany({
      where: { id: job.id, status: JobStatus.DEAD_LETTER },
      data: {
        status: JobStatus.PENDING,
        cycleAttemptCount: 0,
        nextRunAt: now,
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
        completedAt: null
      }
    });
    if (changed.count !== 1) {
      throw new ReplayJobError(
        "INVALID_JOB_STATE",
        "只有 Dead Letter 状态的作业可以人工重放。",
        409
      );
    }

    const attempt = await client.jobAttempt.create({
      data: {
        jobId: job.id,
        attemptNumber: job.attemptCount + 1,
        availableAt: now,
        isReplay: true,
        requestedById: input.actor.id,
        replayReason: reason
      }
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.JOB_REPLAYED,
      objectType: AUDIT_OBJECT_TYPES.PERSISTENT_JOB,
      objectId: job.id,
      context: { ...input.auditContext, actorId: input.actor.id, reason },
      metadata: {
        value: {
          jobId: job.id,
          jobType: job.jobType,
          attemptNumber: attempt.attemptNumber,
          reason
        },
        allowedFields: JOB_REPLAY_AUDIT_FIELDS
      }
    });

    return {
      jobId: job.id,
      status: JobStatus.PENDING,
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      auditId: audit.id
    };
  });
}
