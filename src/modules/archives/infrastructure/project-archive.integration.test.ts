import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";

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
});
