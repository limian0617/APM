import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const actorId = `acceptance-user-${suffix}`;
const projectId = `acceptance-project-${suffix}`;
const otherProjectId = `acceptance-other-project-${suffix}`;
const templateId = `acceptance-template-${suffix}`;
const templateVersionId = `${templateId}-v1`;
const itemId = `${templateVersionId}-item-1`;
const deliveryUnitId = `${projectId}-machine-1`;
const batchId = `${projectId}-batch-1`;

describeDatabase("APM-100 PostgreSQL acceptance constraints", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: actorId,
        employeeNo: `ACCEPTANCE-${suffix}`.toUpperCase(),
        name: "验收集成测试人",
        departmentId: "engineering"
      }
    });
    await db.project.createMany({
      data: [
        {
          id: projectId,
          code: `ACC-${suffix}`.toUpperCase(),
          name: "验收测试项目",
          createdById: actorId
        },
        {
          id: otherProjectId,
          code: `ACC-OTHER-${suffix}`.toUpperCase(),
          name: "其他验收项目",
          createdById: actorId
        }
      ]
    });
    await db.deliveryUnit.create({
      data: {
        id: deliveryUnitId,
        projectId,
        unitType: "MACHINE",
        code: "M-1",
        name: "测试单机",
        position: 1,
        createdById: actorId,
        updatedById: actorId
      }
    });
    await db.acceptanceTemplate.create({
      data: {
        id: templateId,
        code: `ACC.TEMPLATE.${suffix}`.toUpperCase(),
        name: "FAT 基础模板",
        acceptanceType: "FAT",
        createdById: actorId,
        versions: {
          create: {
            id: templateVersionId,
            version: 1,
            acceptanceType: "FAT",
            snapshotChecksum: "sha256:" + "a".repeat(64),
            createdById: actorId,
            items: {
              create: {
                id: itemId,
                code: "POWER",
                name: "上电",
                position: 1,
                method: "观察",
                acceptanceCriteria: "设备正常上电",
                required: true,
                evidenceRequired: false,
                applicableScope: "PROJECT",
                defaultDiscipline: "电气"
              }
            }
          }
        }
      }
    });
  });

  it("enforces project-owned acceptance scopes", async () => {
    await expect(
      db.acceptanceBatch.create({
        data: {
          id: batchId,
          projectId,
          acceptanceType: "FAT",
          scopeType: "MACHINE",
          scopeId: `${otherProjectId}-missing-machine`,
          templateVersionId,
          createdById: actorId
        }
      })
    ).rejects.toBeTruthy();
  });

  it("keeps template versions, batches, result identities and revisions append-only", async () => {
    const batch = await db.acceptanceBatch.create({
      data: {
        id: batchId,
        projectId,
        acceptanceType: "FAT",
        scopeType: "MACHINE",
        scopeId: deliveryUnitId,
        templateVersionId,
        createdById: actorId
      }
    });
    const result = await db.acceptanceTestResult.create({
      data: { projectId, batchId: batch.id, itemId }
    });
    const revision = await db.acceptanceTestResultRevision.create({
      data: {
        projectId,
        resultId: result.id,
        revisionNo: 1,
        decision: "PASS",
        createdById: actorId
      }
    });

    await expect(
      db.acceptanceTemplateVersion.update({
        where: { id: templateVersionId },
        data: { snapshotChecksum: "changed" }
      })
    ).rejects.toBeTruthy();
    await expect(
      db.acceptanceTestResultRevision.update({
        where: { id: revision.id },
        data: { decision: "FAIL" }
      })
    ).rejects.toBeTruthy();
    await expect(
      db.acceptanceTestResultRevision.delete({ where: { id: revision.id } })
    ).rejects.toBeTruthy();

    await db.acceptanceBatch.update({
      where: { id: batch.id },
      data: {
        status: "IN_PROGRESS",
        version: { increment: 1 },
        startedById: actorId,
        startedAt: new Date()
      }
    });
    await db.acceptanceBatch.update({
      where: { id: batch.id },
      data: {
        status: "LOCKED",
        version: { increment: 1 },
        lockedById: actorId,
        lockedAt: new Date()
      }
    });
    await expect(
      db.acceptanceBatch.update({ where: { id: batch.id }, data: { status: "IN_PROGRESS" } })
    ).rejects.toBeTruthy();
    await expect(db.acceptanceBatch.delete({ where: { id: batch.id } })).rejects.toBeTruthy();
  });
});
