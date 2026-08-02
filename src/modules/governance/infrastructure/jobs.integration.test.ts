import { randomUUID } from "node:crypto";

import { JobAttemptStatus, JobStatus } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";

import { loadAuthorizationActor } from "@/lib/auth/repository";
import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import { AUDIT_ACTIONS, AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import {
  updateCompanyCapability,
  updateSystemSetting
} from "@/modules/configuration/application/configuration-service";
import { replayDeadLetterJob } from "@/modules/governance/application/replay-job";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import { runJobBatch } from "@/workers/job-runner";

import {
  claimJobs,
  completeClaimedJob,
  failClaimedJob,
  materializeOutboxEvents
} from "./job-store";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `jobs-admin-${suffix}`,
  engineer: `jobs-engineer-${suffix}`
};

const policy = {
  claimBatchSize: 20,
  leaseSeconds: 60,
  retryBaseSeconds: 1,
  retryMaxSeconds: 30,
  defaultMaxAttempts: 3
};

function context(actorId: string, operationId: string, reason: string | null = null): AuditContext {
  return {
    actorId,
    requestId: `request-${operationId}`,
    traceId: `trace-${operationId}`,
    source: "API",
    sourceIp: "127.0.0.1",
    userAgent: "Vitest",
    reason,
    projectId: null,
    departmentId: null,
    operationId
  };
}

async function actor(userId: string) {
  const value = await loadAuthorizationActor(userId);
  if (!value) throw new Error(`Missing integration actor ${userId}`);
  return value;
}

describeDatabase("APM-004 PostgreSQL Outbox and persistent jobs", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `JOBS-ADMIN-${suffix}`,
          name: "作业管理员",
          departmentId: "hq"
        },
        {
          id: ids.engineer,
          employeeNo: `JOBS-ENG-${suffix}`,
          name: "作业工程师",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `jobs-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        {
          id: `jobs-role-engineer-${suffix}`,
          userId: ids.engineer,
          roleId: "role-engineer"
        }
      ]
    });
  });

  it("rolls business state, success audit and Outbox back together", async () => {
    const operationId = `jobs-rollback-${suffix}`;
    const eventKey = `rollback-${suffix}`;
    const current = await db.systemSetting.findUniqueOrThrow({
      where: { key: "jobs.retryBaseSeconds" }
    });

    await expect(
      db.$transaction(async (transaction) => {
        await transaction.systemSetting.update({
          where: { key: current.key },
          data: { value: 7, version: { increment: 1 } }
        });
        await writeAudit(transaction, {
          action: AUDIT_ACTIONS.CONFIGURATION_SETTING_CHANGED,
          objectType: AUDIT_OBJECT_TYPES.SYSTEM_SETTING,
          objectId: current.key,
          context: context(ids.admin, operationId)
        });
        await appendOutboxEvent(transaction, {
          eventType: "test.business.changed",
          aggregateType: "SYSTEM_SETTING",
          aggregateId: current.key,
          idempotencyKey: eventKey,
          payload: { key: current.key, value: 7 }
        });
        throw new Error("BUSINESS_WRITE_FAILED");
      })
    ).rejects.toThrow("BUSINESS_WRITE_FAILED");

    await expect(
      db.systemSetting.findUniqueOrThrow({ where: { key: current.key } })
    ).resolves.toMatchObject({
      version: current.version,
      value: current.value
    });
    await expect(db.auditLog.count({ where: { operationId } })).resolves.toBe(0);
    await expect(
      db.outboxEvent.count({
        where: { eventType: "test.business.changed", idempotencyKey: eventKey }
      })
    ).resolves.toBe(0);
  });

  it("versions and audits settings and company capabilities with an Outbox event", async () => {
    const setting = await db.systemSetting.findUniqueOrThrow({
      where: { key: "jobs.claimBatchSize" }
    });
    const settingResult = await updateSystemSetting({
      key: setting.key,
      value: Number(setting.value) + 1,
      version: setting.version,
      reason: "验证版本化运行配置",
      actorId: ids.admin,
      auditContext: context(ids.admin, `setting-${suffix}`, "验证版本化运行配置")
    });
    const capability = await db.companyCapability.findUniqueOrThrow({
      where: { code: "UPH_ANALYSIS" }
    });
    const capabilityResult = await updateCompanyCapability({
      code: "UPH_ANALYSIS",
      enabled: !capability.enabled,
      version: capability.version,
      reason: "验证公司能力开关",
      actorId: ids.admin,
      auditContext: context(ids.admin, `capability-${suffix}`, "验证公司能力开关")
    });

    await expect(
      db.systemSettingRevision.findUniqueOrThrow({
        where: {
          settingKey_version: {
            settingKey: setting.key,
            version: settingResult.setting.version
          }
        }
      })
    ).resolves.toMatchObject({ changedById: ids.admin, changeReason: "验证版本化运行配置" });
    await expect(
      db.companyCapabilityRevision.findUniqueOrThrow({
        where: {
          capabilityCode_version: {
            capabilityCode: capability.code,
            version: capabilityResult.capability.version
          }
        }
      })
    ).resolves.toMatchObject({ changedById: ids.admin, changeReason: "验证公司能力开关" });
    await expect(
      db.auditLog.findUniqueOrThrow({ where: { id: settingResult.auditId } })
    ).resolves.toMatchObject({
      action: "CONFIGURATION_SETTING_CHANGED",
      result: "SUCCESS"
    });
    await expect(
      db.outboxEvent.findUniqueOrThrow({ where: { id: capabilityResult.outboxEventId } })
    ).resolves.toMatchObject({ eventType: "configuration.company-capability.changed" });
    await expect(
      updateSystemSetting({
        key: setting.key,
        value: Number(setting.value) + 2,
        version: setting.version,
        reason: "过期版本必须冲突",
        actorId: ids.admin,
        auditContext: context(ids.admin, `setting-conflict-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });

    const effects: string[] = [];
    await runJobBatch({
      workerId: `configuration-worker-${suffix}`,
      policy: { ...policy, claimBatchSize: 1_000 },
      handlers: {
        "configuration.setting.changed": async (job) => {
          effects.push(job.idempotencyKey);
        },
        "configuration.company-capability.changed": async (job) => {
          effects.push(job.idempotencyKey);
        }
      }
    });
    const expectedEffects = [
      `${setting.key}:v${settingResult.setting.version}`,
      `${capability.code}:v${capabilityResult.capability.version}`
    ];
    expect(effects).toEqual(expect.arrayContaining(expectedEffects));
    for (const expectedEffect of expectedEffects) {
      expect(effects.filter((effect) => effect === expectedEffect)).toHaveLength(1);
    }
  });

  it("uses SKIP LOCKED so concurrent workers never claim the same job", async () => {
    const eventType = `test.concurrent.${suffix}`;
    const event = await appendOutboxEvent(db, {
      eventType,
      aggregateType: "TEST",
      aggregateId: suffix,
      idempotencyKey: `concurrent-${suffix}`,
      payload: { suffix }
    });
    const [jobId] = await materializeOutboxEvents({
      limit: 20,
      maxAttempts: 3,
      eventTypes: [eventType]
    });
    expect(jobId).toBeTruthy();

    const [first, second] = await Promise.all([
      claimJobs({ workerId: `worker-a-${suffix}`, policy, jobTypes: [eventType] }),
      claimJobs({ workerId: `worker-b-${suffix}`, policy, jobTypes: [eventType] })
    ]);
    const claims = [...first, ...second].filter(
      ({ idempotencyKey }) => idempotencyKey === event.idempotencyKey
    );
    expect(claims).toHaveLength(1);
    expect(new Set(claims.map(({ id }) => id)).size).toBe(1);
    await completeClaimedJob(claims[0]!);
  });

  it("deduplicates repeated event consumption and invokes the effect once", async () => {
    const input = {
      eventType: `test.idempotent.${suffix}`,
      aggregateType: "TEST",
      aggregateId: suffix,
      idempotencyKey: `idempotent-${suffix}`,
      payload: { b: 2, a: 1 }
    } as const;
    const first = await appendOutboxEvent(db, input);
    const duplicate = await appendOutboxEvent(db, { ...input, payload: { a: 1, b: 2 } });
    expect(duplicate.id).toBe(first.id);
    await expect(
      appendOutboxEvent(db, { ...input, payload: { a: 1, b: 3 } })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    let effectCount = 0;
    const handlers = {
      [input.eventType]: async () => {
        effectCount += 1;
      }
    };
    await runJobBatch({ workerId: `idempotent-worker-${suffix}`, handlers, policy });
    await runJobBatch({ workerId: `idempotent-worker-${suffix}`, handlers, policy });

    expect(effectCount).toBe(1);
    await expect(
      db.persistentJob.count({
        where: { jobType: input.eventType, idempotencyKey: input.idempotencyKey }
      })
    ).resolves.toBe(1);
  });

  it("recovers an expired lease before another worker executes the retry", async () => {
    const eventType = `test.lease.${suffix}`;
    const eventKey = `lease-${suffix}`;
    await appendOutboxEvent(db, {
      eventType,
      aggregateType: "TEST",
      aggregateId: suffix,
      idempotencyKey: eventKey,
      payload: { lease: true }
    });
    await materializeOutboxEvents({ limit: 20, maxAttempts: 2, eventTypes: [eventType] });
    const first = (
      await claimJobs({ workerId: `lease-worker-a-${suffix}`, policy, jobTypes: [eventType] })
    ).find(({ idempotencyKey }) => idempotencyKey === eventKey);
    expect(first).toBeTruthy();
    await db.persistentJob.update({
      where: { id: first!.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) }
    });

    await claimJobs({ workerId: `lease-recovery-${suffix}`, policy, jobTypes: [eventType] });
    await expect(
      db.jobAttempt.findUniqueOrThrow({ where: { id: first!.attemptId } })
    ).resolves.toMatchObject({ status: JobAttemptStatus.FAILED, errorCode: "LEASE_EXPIRED" });

    const due = new Date(Date.now() - 1000);
    await db.$transaction([
      db.persistentJob.update({ where: { id: first!.id }, data: { nextRunAt: due } }),
      db.jobAttempt.updateMany({
        where: { jobId: first!.id, status: JobAttemptStatus.QUEUED },
        data: { availableAt: due }
      })
    ]);
    const recovered = (
      await claimJobs({ workerId: `lease-worker-b-${suffix}`, policy, jobTypes: [eventType] })
    ).find(({ id }) => id === first!.id);
    expect(recovered).toMatchObject({ attemptNumber: 2, workerId: `lease-worker-b-${suffix}` });
    await completeClaimedJob(recovered!);
  });

  it("backs off, enters Dead Letter, and replays with authorization and full history", async () => {
    const eventType = `test.failure.${suffix}`;
    const eventKey = `failure-${suffix}`;
    await appendOutboxEvent(db, {
      eventType,
      aggregateType: "TEST",
      aggregateId: suffix,
      idempotencyKey: eventKey,
      payload: { shouldFail: true }
    });
    await materializeOutboxEvents({ limit: 20, maxAttempts: 2, eventTypes: [eventType] });

    const first = (
      await claimJobs({ workerId: `failure-worker-${suffix}`, policy, jobTypes: [eventType] })
    ).find(({ idempotencyKey }) => idempotencyKey === eventKey);
    expect(first).toBeTruthy();
    const firstFailure = await failClaimedJob(
      first!,
      { code: "TEST_FAILURE_ONE", message: "第一次失败" },
      policy
    );
    expect(firstFailure.status).toBe(JobStatus.RETRY_SCHEDULED);
    expect(firstFailure.nextRunAt.getTime()).toBeGreaterThan(Date.now() - 1000);

    const due = new Date(Date.now() - 1000);
    await db.$transaction([
      db.persistentJob.update({ where: { id: first!.id }, data: { nextRunAt: due } }),
      db.jobAttempt.updateMany({
        where: { jobId: first!.id, status: JobAttemptStatus.QUEUED },
        data: { availableAt: due }
      })
    ]);
    const second = (
      await claimJobs({ workerId: `failure-worker-${suffix}`, policy, jobTypes: [eventType] })
    ).find(({ id }) => id === first!.id);
    expect(second?.attemptNumber).toBe(2);
    const secondFailure = await failClaimedJob(
      second!,
      { code: "TEST_FAILURE_TWO", message: "第二次失败" },
      policy
    );
    expect(secondFailure.status).toBe(JobStatus.DEAD_LETTER);
    await expect(
      db.persistentJob.findUniqueOrThrow({ where: { id: first!.id } })
    ).resolves.toMatchObject({
      status: JobStatus.DEAD_LETTER,
      attemptCount: 2,
      lastErrorCode: "TEST_FAILURE_TWO"
    });

    await expect(
      replayDeadLetterJob({
        jobId: first!.id,
        actor: await actor(ids.engineer),
        reason: "无权限重放",
        auditContext: context(ids.engineer, `replay-denied-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    const replay = await replayDeadLetterJob({
      jobId: first!.id,
      actor: await actor(ids.admin),
      reason: "故障已排除，批准重放",
      auditContext: context(ids.admin, `replay-success-${suffix}`, "故障已排除，批准重放")
    });
    expect(replay).toMatchObject({ status: JobStatus.PENDING, attemptNumber: 3 });
    await expect(
      replayDeadLetterJob({
        jobId: first!.id,
        actor: await actor(ids.admin),
        reason: "重复重放应被拒绝",
        auditContext: context(ids.admin, `replay-conflict-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "INVALID_JOB_STATE", status: 409 });

    const attempts = await db.jobAttempt.findMany({
      where: { jobId: first!.id },
      orderBy: { attemptNumber: "asc" }
    });
    expect(attempts).toHaveLength(3);
    expect(attempts.slice(0, 2).map(({ status, errorCode }) => ({ status, errorCode }))).toEqual([
      { status: JobAttemptStatus.FAILED, errorCode: "TEST_FAILURE_ONE" },
      { status: JobAttemptStatus.FAILED, errorCode: "TEST_FAILURE_TWO" }
    ]);
    expect(attempts[2]).toMatchObject({
      status: JobAttemptStatus.QUEUED,
      isReplay: true,
      requestedById: ids.admin,
      replayReason: "故障已排除，批准重放"
    });
    await expect(
      db.jobAttempt.update({
        where: { id: attempts[0]!.id },
        data: { errorMessage: "试图改写历史" }
      })
    ).rejects.toThrow(/immutable/);
    await expect(
      db.auditLog.findUniqueOrThrow({ where: { id: replay.auditId } })
    ).resolves.toMatchObject({
      action: "JOB_REPLAYED",
      objectId: first!.id,
      reason: "故障已排除，批准重放"
    });
  });
});
