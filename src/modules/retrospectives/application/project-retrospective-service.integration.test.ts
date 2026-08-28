import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  user: `retro-user-${suffix}`,
  reviewer: `retro-reviewer-${suffix}`,
  project: `retro-project-${suffix}`,
  archive: `retro-archive-${suffix}`,
  archiveVersion: `retro-archive-version-${suffix}`
};

describeDatabase("APM-104 retrospective PostgreSQL workflow", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.user,
          employeeNo: `RETRO-${suffix}`.toUpperCase(),
          name: "复盘提交人",
          departmentId: "engineering"
        },
        {
          id: ids.reviewer,
          employeeNo: `REVIEW-${suffix}`.toUpperCase(),
          name: "复盘审核人",
          departmentId: "engineering"
        }
      ]
    });
    await db.project.create({
      data: {
        id: ids.project,
        code: `RETRO-${suffix}`.toUpperCase(),
        name: "复盘集成测试项目",
        createdById: ids.user
      }
    });
    await db.projectMember.createMany({
      data: [
        {
          id: `retro-member-${suffix}`,
          projectId: ids.project,
          userId: ids.user,
          projectRole: "PROJECT_MANAGER",
          assignedById: ids.user
        },
        {
          id: `retro-reviewer-member-${suffix}`,
          projectId: ids.project,
          userId: ids.reviewer,
          projectRole: "QUALITY",
          assignedById: ids.user
        }
      ]
    });
    await db.projectArchive.create({
      data: {
        id: ids.archive,
        projectId: ids.project,
        versions: {
          create: {
            id: ids.archiveVersion,
            version: 1,
            status: "READY",
            manifestChecksum: "a".repeat(64),
            sourceWatermark: "b".repeat(64),
            snapshotJson: { sourceCount: 1 },
            externalPublicationApplicability: "NOT_APPLICABLE",
            externalPublicationReason: "内部复盘输入归档。",
            archiveSourceFormulaVersion: "V2",
            retrospectiveInputApplicability: "APPLICABLE",
            retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
            retrospectiveInputSnapshotJson: { formulaVersion: "RETROSPECTIVE.INPUT@1" },
            retrospectiveInputWatermark: "c".repeat(64),
            createdById: ids.user
          }
        }
      }
    });
  });

  it("keeps cross-project source foreign keys and append-only history enforced", async () => {
    const retrospective = await db.projectRetrospective.create({
      data: {
        id: `retrospective-${suffix}`,
        projectId: ids.project,
        version: 1,
        createdById: ids.user,
        updatedById: ids.user
      }
    });
    const version = await db.projectRetrospectiveVersion.create({
      data: {
        id: `retrospective-version-${suffix}`,
        projectId: ids.project,
        retrospectiveId: retrospective.id,
        versionNo: 1,
        status: "DRAFT",
        retrospectiveInputArchiveVersionId: ids.archiveVersion,
        retrospectiveInputManifestChecksum: "a".repeat(64),
        retrospectiveInputSourceWatermark: "b".repeat(64),
        retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
        retrospectiveInputWatermark: "c".repeat(64),
        projectSnapshotJson: { id: ids.project },
        deliverySummaryJson: { summary: "完成" },
        successfulPracticesJson: { practices: [] },
        shortcomingsJson: { items: [] },
        improvementsJson: { actions: [] },
        knowledgeDispositionJson: { disposition: "NONE" },
        ipDeclarationJson: { sanitized: true },
        contentChecksum: "d".repeat(64),
        createdById: ids.user
      }
    });
    await expect(
      db.projectRetrospectiveVersion.update({
        where: { id: version.id },
        data: { contentChecksum: "e".repeat(64) }
      })
    ).rejects.toBeTruthy();
  });
});
