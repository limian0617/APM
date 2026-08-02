import { JobAttemptStatus, JobStatus, Prisma, type PrismaClient } from "@prisma/client";

import { db } from "@/lib/db";

import type { JobExecution, WorkerPolicy } from "../contracts/jobs";
import type { JsonValue } from "../domain/idempotency";
import { nextRetryAt } from "../domain/job-policy";

type Database = Pick<PrismaClient, "$transaction">;

type DatabaseClock = { now: Date };

type LockedOutboxRow = {
  id: string;
  event_type: string;
  payload: Prisma.JsonValue;
  payload_hash: string;
  idempotency_key: string;
};

type LockedJobRow = {
  id: string;
  job_type: string;
  payload: Prisma.JsonValue;
  payload_hash: string;
  idempotency_key: string;
  max_attempts: number;
  attempt_count: number;
  cycle_attempt_count: number;
};

export class JobStateError extends Error {
  constructor(
    readonly code: "JOB_NOT_CLAIMED" | "JOB_ATTEMPT_MISSING" | "JOB_PAYLOAD_CONFLICT",
    message: string
  ) {
    super(message);
  }
}

function positiveInteger(value: number, field: string, maximum = 10_000): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${field} 必须是 1 到 ${maximum} 之间的整数。`);
  }
  return value;
}

function errorText(value: string, maximum: number): string {
  return value.trim().slice(0, maximum) || "UNKNOWN_JOB_FAILURE";
}

async function databaseNow(transaction: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await transaction.$queryRaw<DatabaseClock[]>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) {
    throw new Error("无法读取数据库时间。");
  }
  return clock.now;
}

export async function materializeOutboxEvents(
  input: { limit: number; maxAttempts: number },
  database: Database = db
) {
  const limit = positiveInteger(input.limit, "limit", 500);
  const maxAttempts = positiveInteger(input.maxAttempts, "maxAttempts", 100);

  return database.$transaction(async (transaction) => {
    const now = await databaseNow(transaction);
    const events = await transaction.$queryRaw<LockedOutboxRow[]>(Prisma.sql`
      SELECT "id", "event_type", "payload", "payload_hash", "idempotency_key"
      FROM "outbox_events"
      WHERE "dispatched_at" IS NULL
      ORDER BY "occurred_at", "id"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);

    const jobIds: string[] = [];
    for (const event of events) {
      let job = await transaction.persistentJob.findUnique({
        where: { sourceOutboxEventId: event.id }
      });
      if (!job) {
        const duplicate = await transaction.persistentJob.findUnique({
          where: {
            jobType_idempotencyKey: {
              jobType: event.event_type,
              idempotencyKey: event.idempotency_key
            }
          }
        });
        if (duplicate) {
          if (duplicate.payloadHash !== event.payload_hash) {
            throw new JobStateError(
              "JOB_PAYLOAD_CONFLICT",
              "相同作业类型和幂等键已绑定到不同负载。"
            );
          }
          job = duplicate;
        } else {
          job = await transaction.persistentJob.create({
            data: {
              sourceOutboxEventId: event.id,
              jobType: event.event_type,
              payload: event.payload as Prisma.InputJsonValue,
              payloadHash: event.payload_hash,
              idempotencyKey: event.idempotency_key,
              maxAttempts,
              nextRunAt: now,
              attempts: {
                create: { attemptNumber: 1, availableAt: now }
              }
            }
          });
        }
      }

      await transaction.outboxEvent.update({
        where: { id: event.id },
        data: { dispatchedAt: now }
      });
      jobIds.push(job.id);
    }

    return jobIds;
  });
}

async function recoverExpiredLeases(
  transaction: Prisma.TransactionClient,
  now: Date,
  policy: WorkerPolicy,
  limit: number
) {
  const expired = await transaction.$queryRaw<LockedJobRow[]>(Prisma.sql`
    SELECT "id", "job_type", "payload", "payload_hash", "idempotency_key",
           "max_attempts", "attempt_count", "cycle_attempt_count"
    FROM "persistent_jobs"
    WHERE "status" = 'RUNNING'::"JobStatus"
      AND "lease_expires_at" <= ${now}
    ORDER BY "lease_expires_at", "id"
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `);

  for (const job of expired) {
    const attempt = await transaction.jobAttempt.findFirst({
      where: { jobId: job.id, status: JobAttemptStatus.RUNNING },
      orderBy: { attemptNumber: "desc" }
    });
    if (!attempt) {
      throw new JobStateError("JOB_ATTEMPT_MISSING", "运行中的作业缺少对应执行尝试。");
    }

    await transaction.jobAttempt.update({
      where: { id: attempt.id },
      data: {
        status: JobAttemptStatus.FAILED,
        completedAt: now,
        errorCode: "LEASE_EXPIRED",
        errorMessage: "Worker 租约到期，作业已回收。"
      }
    });

    const deadLetter = job.cycle_attempt_count >= job.max_attempts;
    const nextRunAt = nextRetryAt(now, job.cycle_attempt_count, {
      baseSeconds: policy.retryBaseSeconds,
      maximumSeconds: policy.retryMaxSeconds
    });
    if (!deadLetter) {
      await transaction.jobAttempt.create({
        data: {
          jobId: job.id,
          attemptNumber: job.attempt_count + 1,
          availableAt: nextRunAt
        }
      });
    }
    await transaction.persistentJob.update({
      where: { id: job.id },
      data: {
        status: deadLetter ? JobStatus.DEAD_LETTER : JobStatus.RETRY_SCHEDULED,
        nextRunAt,
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
        lastErrorCode: "LEASE_EXPIRED",
        lastErrorMessage: "Worker 租约到期，作业已回收。"
      }
    });
  }
}

export async function claimJobs(
  input: { workerId: string; policy: WorkerPolicy },
  database: Database = db
): Promise<JobExecution[]> {
  const workerId = input.workerId.trim().slice(0, 191);
  if (!workerId) {
    throw new TypeError("workerId 不能为空。");
  }
  const limit = positiveInteger(input.policy.claimBatchSize, "claimBatchSize", 500);
  const leaseSeconds = positiveInteger(input.policy.leaseSeconds, "leaseSeconds", 3600);
  positiveInteger(input.policy.retryBaseSeconds, "retryBaseSeconds", 3600);
  positiveInteger(input.policy.retryMaxSeconds, "retryMaxSeconds", 86400);

  return database.$transaction(async (transaction) => {
    const now = await databaseNow(transaction);
    await recoverExpiredLeases(transaction, now, input.policy, limit);

    const jobs = await transaction.$queryRaw<LockedJobRow[]>(Prisma.sql`
      SELECT "id", "job_type", "payload", "payload_hash", "idempotency_key",
             "max_attempts", "attempt_count", "cycle_attempt_count"
      FROM "persistent_jobs"
      WHERE "status" IN ('PENDING'::"JobStatus", 'RETRY_SCHEDULED'::"JobStatus")
        AND "next_run_at" <= ${now}
      ORDER BY "next_run_at", "created_at", "id"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);

    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    const claimed: JobExecution[] = [];
    for (const job of jobs) {
      let attempt = await transaction.jobAttempt.findFirst({
        where: { jobId: job.id, status: JobAttemptStatus.QUEUED },
        orderBy: { attemptNumber: "desc" }
      });
      if (attempt && attempt.availableAt > now) {
        continue;
      }
      if (!attempt) {
        attempt = await transaction.jobAttempt.create({
          data: {
            jobId: job.id,
            attemptNumber: job.attempt_count + 1,
            availableAt: now
          }
        });
      }

      await transaction.jobAttempt.update({
        where: { id: attempt.id },
        data: {
          status: JobAttemptStatus.RUNNING,
          workerId,
          startedAt: now
        }
      });
      await transaction.persistentJob.update({
        where: { id: job.id },
        data: {
          status: JobStatus.RUNNING,
          attemptCount: { increment: 1 },
          cycleAttemptCount: { increment: 1 },
          lockedAt: now,
          lockedBy: workerId,
          leaseExpiresAt
        }
      });

      claimed.push({
        id: job.id,
        jobType: job.job_type,
        payload: job.payload as JsonValue,
        payloadHash: job.payload_hash,
        idempotencyKey: job.idempotency_key,
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        workerId
      });
    }
    return claimed;
  });
}

export async function completeClaimedJob(job: JobExecution, database: Database = db) {
  return database.$transaction(async (transaction) => {
    const now = await databaseNow(transaction);
    const updated = await transaction.persistentJob.updateMany({
      where: { id: job.id, status: JobStatus.RUNNING, lockedBy: job.workerId },
      data: {
        status: JobStatus.SUCCEEDED,
        completedAt: now,
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null
      }
    });
    if (updated.count !== 1) {
      throw new JobStateError("JOB_NOT_CLAIMED", "作业不再由当前 Worker 持有。");
    }

    const attempt = await transaction.jobAttempt.updateMany({
      where: {
        id: job.attemptId,
        jobId: job.id,
        status: JobAttemptStatus.RUNNING,
        workerId: job.workerId
      },
      data: { status: JobAttemptStatus.SUCCEEDED, completedAt: now }
    });
    if (attempt.count !== 1) {
      throw new JobStateError("JOB_ATTEMPT_MISSING", "当前作业执行尝试不存在。");
    }
  });
}

export async function failClaimedJob(
  job: JobExecution,
  failure: { code: string; message: string },
  policy: Pick<WorkerPolicy, "retryBaseSeconds" | "retryMaxSeconds">,
  database: Database = db
) {
  return database.$transaction(async (transaction) => {
    const now = await databaseNow(transaction);
    const current = await transaction.persistentJob.findFirst({
      where: { id: job.id, status: JobStatus.RUNNING, lockedBy: job.workerId }
    });
    if (!current) {
      throw new JobStateError("JOB_NOT_CLAIMED", "作业不再由当前 Worker 持有。");
    }

    const errorCode = errorText(failure.code, 191);
    const errorMessage = errorText(failure.message, 2048);
    const attempt = await transaction.jobAttempt.updateMany({
      where: {
        id: job.attemptId,
        jobId: job.id,
        status: JobAttemptStatus.RUNNING,
        workerId: job.workerId
      },
      data: {
        status: JobAttemptStatus.FAILED,
        completedAt: now,
        errorCode,
        errorMessage
      }
    });
    if (attempt.count !== 1) {
      throw new JobStateError("JOB_ATTEMPT_MISSING", "当前作业执行尝试不存在。");
    }

    const deadLetter = current.cycleAttemptCount >= current.maxAttempts;
    const nextRunAt = nextRetryAt(now, current.cycleAttemptCount, {
      baseSeconds: policy.retryBaseSeconds,
      maximumSeconds: policy.retryMaxSeconds
    });
    if (!deadLetter) {
      await transaction.jobAttempt.create({
        data: {
          jobId: current.id,
          attemptNumber: current.attemptCount + 1,
          availableAt: nextRunAt
        }
      });
    }
    await transaction.persistentJob.update({
      where: { id: current.id },
      data: {
        status: deadLetter ? JobStatus.DEAD_LETTER : JobStatus.RETRY_SCHEDULED,
        nextRunAt,
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage
      }
    });

    return { status: deadLetter ? JobStatus.DEAD_LETTER : JobStatus.RETRY_SCHEDULED, nextRunAt };
  });
}
