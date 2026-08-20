import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { createArchiveIntegrityHandler } from "@/modules/archives/application/archive-integrity-handler";
import { AUDIT_ACTIONS } from "@/modules/audit/domain/vocabulary";
import { MemoryObjectStorage } from "@/modules/documents/infrastructure/memory-object-storage";
import type { JobExecution } from "@/modules/governance/contracts/jobs";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  user: `archive-user-${suffix}`,
  project: `archive-project-${suffix}`,
  archive: `archive-${suffix}`,
  version: `archive-version-${suffix}`,
  item: `archive-item-${suffix}`,
  job: `archive-job-${suffix}`,
  check: `archive-check-${suffix}`,
  result: `archive-result-${suffix}`
};

describeDatabase("APM-054 archive persistence", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: ids.user,
        employeeNo: `ARCHIVE-${suffix}`.toUpperCase(),
        name: "结项归档集成测试人",
        departmentId: "engineering"
      }
    });
    await db.project.create({
      data: {
        id: ids.project,
        code: `ARCHIVE-${suffix}`.toUpperCase(),
        name: "结项归档集成测试项目",
        createdById: ids.user
      }
    });
    await db.projectArchive.create({
      data: {
        id: ids.archive,
        projectId: ids.project,
        versions: {
          create: {
            id: ids.version,
            version: 1,
            status: "READY",
            manifestChecksum: "a".repeat(64),
            sourceWatermark: "b".repeat(64),
            snapshotJson: { sourceCount: 1 },
            externalPublicationApplicability: "NOT_APPLICABLE",
            externalPublicationReason: "外部供应商包未在本工作包实现。",
            archiveSourceFormulaVersion: "V1",
            retrospectiveInputApplicability: "NOT_APPLICABLE",
            createdById: ids.user,
            manifestItems: {
              create: {
                id: ids.item,
                position: 0,
                sourceType: "ACCEPTANCE_BATCH",
                sourceId: `batch-${suffix}`,
                sourceVersion: "LOCKED:1",
                sourceChecksum: "c".repeat(64),
                snapshotJson: { acceptanceType: "SAT" }
              }
            }
          }
        }
      }
    });
  });

  it("rejects mutation and deletion of archive facts", async () => {
    await expect(
      db.projectArchiveManifestItem.update({
        where: { id: ids.item },
        data: { sourceVersion: "LOCKED:2" }
      })
    ).rejects.toBeTruthy();
    await expect(
      db.projectArchiveManifestItem.delete({ where: { id: ids.item } })
    ).rejects.toBeTruthy();
    await expect(
      db.projectArchiveVersion.update({
        where: { id: ids.version },
        data: { manifestChecksum: "d".repeat(64) }
      })
    ).rejects.toBeTruthy();
    await expect(
      db.projectArchiveVersion.delete({ where: { id: ids.version } })
    ).rejects.toBeTruthy();
  });

  it("allows a verification transition but keeps integrity results append-only", async () => {
    const verifyingVersion = await db.projectArchiveVersion.update({
      where: { id: ids.version },
      data: { status: "VERIFYING" }
    });
    expect(verifyingVersion.status).toBe("VERIFYING");

    await db.persistentJob.create({
      data: {
        id: ids.job,
        jobType: "archive.integrity.check",
        payload: { archiveVersionId: ids.version },
        payloadHash: "e".repeat(64),
        idempotencyKey: `archive-check-${suffix}`,
        maxAttempts: 3
      }
    });
    await db.projectArchiveIntegrityCheck.create({
      data: {
        id: ids.check,
        projectId: ids.project,
        archiveVersionId: ids.version,
        sequence: 1,
        jobId: ids.job,
        status: "FAILED",
        inputChecksum: "f".repeat(64),
        resultChecksum: "0".repeat(64),
        checkedAt: new Date(),
        results: {
          create: {
            id: ids.result,
            manifestItemId: ids.item,
            status: "FAILED",
            failureCode: "ARCHIVE_FILE_HASH_MISMATCH",
            checkedAt: new Date()
          }
        }
      }
    });
    await expect(
      db.projectArchiveIntegrityItemResult.update({
        where: { id: ids.result },
        data: { failureMessage: "changed" }
      })
    ).rejects.toBeTruthy();
  });

  it("persists one terminal append-only integrity result and leaves a replay as a no-op", async () => {
    const handlerVersionId = `archive-handler-version-${suffix}`;
    const handlerItemId = `archive-handler-item-${suffix}`;
    const handlerJobId = `archive-handler-job-${suffix}`;
    const handler = createArchiveIntegrityHandler({
      storage: new MemoryObjectStorage(),
      client: db
    });

    await db.projectArchiveVersion.create({
      data: {
        id: handlerVersionId,
        archiveId: ids.archive,
        projectId: ids.project,
        version: 2,
        status: "READY",
        manifestChecksum: "1".repeat(64),
        sourceWatermark: "2".repeat(64),
        snapshotJson: { sourceCount: 1 },
        externalPublicationApplicability: "NOT_APPLICABLE",
        externalPublicationReason: "外部供应商包未在本工作包实现。",
        archiveSourceFormulaVersion: "V1",
        retrospectiveInputApplicability: "NOT_APPLICABLE",
        createdById: ids.user,
        manifestItems: {
          create: {
            id: handlerItemId,
            position: 0,
            sourceType: "ACCEPTANCE_BATCH",
            sourceId: `handler-batch-${suffix}`,
            sourceVersion: "LOCKED:1",
            sourceChecksum: "3".repeat(64),
            snapshotJson: { acceptanceType: "SAT" }
          }
        }
      }
    });
    const persistentJob = await db.persistentJob.create({
      data: {
        id: handlerJobId,
        jobType: "archive.integrity.check",
        payload: { projectId: ids.project, archiveVersionId: handlerVersionId },
        payloadHash: "4".repeat(64),
        idempotencyKey: `archive-handler-check-${suffix}`,
        maxAttempts: 3
      }
    });
    const job: JobExecution = {
      id: persistentJob.id,
      jobType: persistentJob.jobType,
      payload: { projectId: ids.project, archiveVersionId: handlerVersionId },
      payloadHash: persistentJob.payloadHash,
      idempotencyKey: persistentJob.idempotencyKey,
      traceId: "1".repeat(32),
      attemptId: `archive-handler-attempt-${suffix}`,
      attemptNumber: 1,
      maxAttempts: persistentJob.maxAttempts,
      isReplay: false,
      workerId: `archive-handler-worker-${suffix}`
    };

    await handler(job);

    const checks = await db.projectArchiveIntegrityCheck.findMany({
      where: { jobId: persistentJob.id },
      include: { results: { orderBy: { manifestItemId: "asc" } } }
    });
    expect(checks).toHaveLength(1);
    const [check] = checks;
    expect(check).toBeDefined();
    expect(check?.status).toBe("PASSED");
    expect(check?.resultChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(check?.resultChecksum).not.toBe("0".repeat(64));
    expect(check?.results).toEqual([
      expect.objectContaining({ manifestItemId: handlerItemId, status: "NOT_APPLICABLE" })
    ]);

    const completedVersion = await db.projectArchiveVersion.findUniqueOrThrow({
      where: { id: handlerVersionId }
    });
    expect(completedVersion.status).toBe("READY");
    expect(
      await db.auditLog.count({
        where: {
          action: AUDIT_ACTIONS.PROJECT_ARCHIVE_INTEGRITY_CHECKED,
          objectId: check?.id
        }
      })
    ).toBe(1);
    expect(
      await db.outboxEvent.count({
        where: { eventType: "archive.integrity.checked", idempotencyKey: `${check?.id}:completed` }
      })
    ).toBe(1);

    const beforeReplay = {
      checks: await db.projectArchiveIntegrityCheck.count({ where: { jobId: persistentJob.id } }),
      results: await db.projectArchiveIntegrityItemResult.count({
        where: { integrityCheckId: check?.id }
      }),
      audits: await db.auditLog.count({
        where: {
          action: AUDIT_ACTIONS.PROJECT_ARCHIVE_INTEGRITY_CHECKED,
          objectId: check?.id
        }
      }),
      outbox: await db.outboxEvent.count({
        where: { eventType: "archive.integrity.checked", idempotencyKey: `${check?.id}:completed` }
      })
    };
    await handler(job);
    expect({
      checks: await db.projectArchiveIntegrityCheck.count({ where: { jobId: persistentJob.id } }),
      results: await db.projectArchiveIntegrityItemResult.count({
        where: { integrityCheckId: check?.id }
      }),
      audits: await db.auditLog.count({
        where: {
          action: AUDIT_ACTIONS.PROJECT_ARCHIVE_INTEGRITY_CHECKED,
          objectId: check?.id
        }
      }),
      outbox: await db.outboxEvent.count({
        where: { eventType: "archive.integrity.checked", idempotencyKey: `${check?.id}:completed` }
      })
    }).toEqual(beforeReplay);

    await expect(
      db.projectArchiveIntegrityCheck.update({
        where: { id: check?.id },
        data: { status: "FAILED" }
      })
    ).rejects.toBeTruthy();
    await expect(
      db.projectArchiveIntegrityCheck.delete({ where: { id: check?.id } })
    ).rejects.toBeTruthy();
    await expect(
      db.projectArchiveIntegrityItemResult.update({
        where: { id: check?.results[0]?.id },
        data: { failureMessage: "changed" }
      })
    ).rejects.toBeTruthy();
    await expect(
      db.projectArchiveIntegrityItemResult.delete({ where: { id: check?.results[0]?.id } })
    ).rejects.toBeTruthy();
  });
});
