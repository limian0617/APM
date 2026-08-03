import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `stage-admin-${suffix}`
};

async function seedStageFacts(label: string) {
  const project = await db.project.create({
    data: {
      code: `P30.${label}.${suffix}`.toUpperCase(),
      name: `${label} stage persistence project`,
      departmentId: "engineering",
      createdById: ids.admin
    }
  });
  const deliveryUnit = await db.deliveryUnit.create({
    data: {
      projectId: project.id,
      unitType: "MACHINE",
      code: `MACHINE.${label}`.toUpperCase(),
      name: `${label} stage test machine`,
      position: 0,
      createdById: ids.admin,
      updatedById: ids.admin
    }
  });
  const firstStage = await db.projectStage.create({
    data: {
      projectId: project.id,
      code: "S0",
      name: "Project kickoff",
      sequence: 0,
      createdById: ids.admin,
      updatedById: ids.admin
    }
  });
  const secondStage = await db.projectStage.create({
    data: {
      projectId: project.id,
      code: "S1",
      name: "Requirements freeze",
      sequence: 1,
      createdById: ids.admin,
      updatedById: ids.admin
    }
  });
  await db.project.update({
    where: { id: project.id },
    data: {
      mainControlStageId: firstStage.id,
      mainControlStageProjectId: project.id,
      mainControlStageCode: firstStage.code,
      mainControlStageStatus: firstStage.status,
      mainControlStageSequence: firstStage.sequence,
      mainControlStageUpdatedAt: firstStage.statusChangedAt
    }
  });
  const deliveryUnitStage = await db.deliveryUnitStage.create({
    data: {
      projectId: project.id,
      deliveryUnitId: deliveryUnit.id,
      projectStageId: firstStage.id,
      createdById: ids.admin,
      updatedById: ids.admin
    }
  });
  const releaseAuthorization = await db.stageReleaseAuthorization.create({
    data: {
      projectId: project.id,
      scope: "PROJECT",
      fromProjectStageId: firstStage.id,
      toProjectStageId: secondStage.id,
      reason: "Authorize the adjacent stage for test coverage",
      authorizedById: ids.admin
    }
  });

  return { project, firstStage, deliveryUnitStage, releaseAuthorization };
}

describeDatabase("APM-030 PostgreSQL project stage persistence", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: ids.admin,
        employeeNo: `STAGE-ADMIN-${suffix}`,
        name: "Stage persistence administrator",
        departmentId: "engineering"
      }
    });
  });

  it("synchronizes the selected project main-control summary after its stage status changes", async () => {
    const facts = await seedStageFacts("SUMMARY");
    const statusChangedAt = new Date("2026-08-04T04:45:00.000Z");

    await db.projectStage.update({
      where: { id: facts.firstStage.id },
      data: {
        status: "AUTHORIZED",
        statusChangedAt,
        updatedById: ids.admin,
        version: { increment: 1 }
      }
    });

    await expect(
      db.project.findUniqueOrThrow({ where: { id: facts.project.id } })
    ).resolves.toMatchObject({
      mainControlStageId: facts.firstStage.id,
      mainControlStageProjectId: facts.project.id,
      mainControlStageCode: facts.firstStage.code,
      mainControlStageStatus: "AUTHORIZED",
      mainControlStageSequence: facts.firstStage.sequence,
      mainControlStageUpdatedAt: statusChangedAt
    });
  });

  it("rejects raw primary-key mutations for persisted stage facts", async () => {
    const facts = await seedStageFacts("IDENTITY");

    await expect(
      db.$executeRaw`UPDATE "project_stages" SET "id" = ${`mutated-project-stage-${suffix}`} WHERE "id" = ${facts.firstStage.id}`
    ).rejects.toThrow(/project stage stable identity is immutable/u);
    await expect(
      db.$executeRaw`UPDATE "delivery_unit_stages" SET "id" = ${`mutated-delivery-unit-stage-${suffix}`} WHERE "id" = ${facts.deliveryUnitStage.id}`
    ).rejects.toThrow(/delivery unit stage stable identity is immutable/u);
    await expect(
      db.$executeRaw`UPDATE "stage_release_authorizations" SET "id" = ${`mutated-stage-release-${suffix}`} WHERE "id" = ${facts.releaseAuthorization.id}`
    ).rejects.toThrow(/stage release authorization stable identity is immutable/u);
  });
});
