import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  publishProjectTemplate,
  publishTemplateComponent,
  saveProjectTemplateDraft,
  saveTemplateComponentDraft
} from "@/modules/configuration/application/template-service";
import { createProjectFromTemplate } from "@/modules/projects/application/create-project";
import { initializeProjectStructure } from "@/modules/projects/application/project-structure";
import {
  authorizeStageRelease,
  revokeStageRelease,
  transitionProjectStage
} from "@/modules/projects/application/project-stage-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `stage-admin-${suffix}`
};

function auditContext(operationId: string, projectId: string | null = null): AuditContext {
  return {
    actorId: ids.admin,
    requestId: `request-${operationId}`,
    traceId: `trace-${operationId}`,
    source: "API",
    sourceIp: null,
    userAgent: "Vitest",
    reason: null,
    projectId,
    departmentId: "engineering",
    operationId
  };
}

function componentDefinition(type: "STAGE" | "GATE" | "ROLE" | "WBS") {
  switch (type) {
    case "STAGE":
      return {
        stages: [
          { code: "S0", name: "Project kickoff", sequence: 0 },
          { code: "S1", name: "Requirements freeze", sequence: 1 },
          { code: "S2", name: "Detailed design", sequence: 2 },
          { code: "S3", name: "Procurement and manufacture", sequence: 3 },
          { code: "S4", name: "Assembly and commissioning", sequence: 4 },
          { code: "S5", name: "System integration", sequence: 5 },
          { code: "S6", name: "FAT and shipment", sequence: 6 },
          { code: "S7", name: "Site acceptance", sequence: 7 },
          { code: "S8", name: "Project handover", sequence: 8 }
        ]
      };
    case "GATE":
      return {
        gates: [
          {
            code: "G1",
            name: "Execution baseline approval",
            stageCode: "S0",
            requiredCheckerCodes: ["DOCUMENTS.COMPLETE"]
          }
        ]
      };
    case "ROLE":
      return { roles: [{ code: "PROJECT_MANAGER", name: "Project manager", required: true }] };
    case "WBS":
      return {
        packages: [{ code: "S0.KICKOFF", name: "Project kickoff", stageCode: "S0", weight: 10 }]
      };
  }
}

async function seedPublishedStageTemplate() {
  const componentVersions = await Promise.all(
    (["STAGE", "GATE", "ROLE", "WBS"] as const).map(async (componentType) => {
      const code = `APM030.${componentType}.${suffix}`.toUpperCase();
      const draft = await saveTemplateComponentDraft({
        code,
        componentType,
        name: `${componentType} stage test`,
        content: componentDefinition(componentType),
        version: 0,
        reason: "Create stage integration test component",
        actorId: ids.admin,
        auditContext: auditContext(`component-draft-${componentType}-${suffix}`)
      });
      return (
        await publishTemplateComponent({
          code,
          version: draft.component.version,
          reason: "Publish stage integration test component",
          actorId: ids.admin,
          auditContext: auditContext(`component-publish-${componentType}-${suffix}`)
        })
      ).publishedVersion;
    })
  );
  const code = `APM030.TEMPLATE.${suffix}`.toUpperCase();
  const draft = await saveProjectTemplateDraft({
    code,
    name: "APM-030 stage integration template",
    components: componentVersions.map((component, position) => ({
      componentVersionId: component.id,
      componentType: component.componentType,
      slot: `${component.componentType}.${position}`,
      position
    })),
    version: 0,
    reason: "Create stage integration test template",
    actorId: ids.admin,
    auditContext: auditContext(`template-draft-${suffix}`)
  });
  const published = await publishProjectTemplate({
    code,
    version: draft.template.version,
    reason: "Publish stage integration test template",
    actorId: ids.admin,
    auditContext: auditContext(`template-publish-${suffix}`)
  });
  return { code, ...published };
}

let stageTemplate: Awaited<ReturnType<typeof seedPublishedStageTemplate>>;

async function seedStageFacts(label: string) {
  const created = await createProjectFromTemplate({
    code: `P30.${label}.${suffix}`.toUpperCase(),
    name: `${label} stage persistence project`,
    departmentId: "engineering",
    templateCode: stageTemplate.code,
    templateVersion: stageTemplate.publishedVersion.version,
    templateChecksum: stageTemplate.publishedVersion.checksum,
    reason: "Create stage persistence project",
    actorId: ids.admin,
    auditContext: auditContext(`project-create-${label}-${suffix}`)
  });
  const structure = await initializeProjectStructure({
    projectId: created.project.id,
    projectVersion: created.project.version,
    projectType: "CUSTOMER_DELIVERY",
    equipmentShape: "SINGLE_MACHINE",
    deliveryUnits: [
      {
        code: `MACHINE.${label}`.toUpperCase(),
        name: `${label} stage test machine`,
        unitType: "MACHINE",
        parentCode: null,
        position: 0
      }
    ],
    modules: [],
    reason: "Initialize stage persistence delivery unit",
    actorId: ids.admin,
    auditContext: auditContext(`structure-init-${label}-${suffix}`, created.project.id)
  });
  const projectStages = await db.projectStage.findMany({
    where: { projectId: created.project.id },
    orderBy: { sequence: "asc" }
  });
  const firstStage = projectStages[0];
  const secondStage = projectStages[1];
  const deliveryUnit = structure.deliveryUnits[0];
  if (!firstStage || !secondStage || !deliveryUnit) {
    throw new Error("Stage persistence seed requires two project stages and one delivery unit.");
  }
  const project = await db.project.update({
    where: { id: created.project.id },
    data: {
      status: "IN_PROGRESS"
    }
  });
  const deliveryUnitStage = await db.deliveryUnitStage.findFirstOrThrow({
    where: {
      projectId: project.id,
      deliveryUnitId: deliveryUnit.id,
      projectStageId: firstStage.id
    }
  });
  return { project, firstStage, secondStage, deliveryUnitStage };
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
    stageTemplate = await seedPublishedStageTemplate();
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
    const releaseAuthorization = await db.stageReleaseAuthorization.create({
      data: {
        projectId: facts.project.id,
        scope: "PROJECT",
        fromProjectStageId: facts.firstStage.id,
        toProjectStageId: facts.secondStage.id,
        reason: "Authorize the adjacent stage for identity coverage",
        authorizedById: ids.admin
      }
    });

    await expect(
      db.$executeRaw`UPDATE "project_stages" SET "id" = ${`mutated-project-stage-${suffix}`} WHERE "id" = ${facts.firstStage.id}`
    ).rejects.toThrow(/project stage stable identity is immutable/u);
    await expect(
      db.$executeRaw`UPDATE "delivery_unit_stages" SET "id" = ${`mutated-delivery-unit-stage-${suffix}`} WHERE "id" = ${facts.deliveryUnitStage.id}`
    ).rejects.toThrow(/delivery unit stage stable identity is immutable/u);
    await expect(
      db.$executeRaw`UPDATE "stage_release_authorizations" SET "id" = ${`mutated-stage-release-${suffix}`} WHERE "id" = ${releaseAuthorization.id}`
    ).rejects.toThrow(/stage release authorization stable identity is immutable/u);
  });

  it("requires an active adjacent release before authorizing an unfinished next project stage", async () => {
    const facts = await seedStageFacts("COMMAND");
    const auditContext = {
      actorId: ids.admin,
      requestId: null,
      traceId: null,
      source: "API" as const,
      sourceIp: null,
      userAgent: null,
      reason: "Stage command integration test",
      projectId: facts.project.id,
      departmentId: "engineering",
      operationId: null
    };
    const nextStage = facts.secondStage;

    await expect(
      transitionProjectStage({
        projectId: facts.project.id,
        stageId: nextStage.id,
        toStatus: "AUTHORIZED",
        version: nextStage.version,
        reason: "Try to start the next stage without release",
        actorId: ids.admin,
        auditContext
      })
    ).rejects.toMatchObject({ code: "STAGE_RELEASE_REQUIRED" });

    const authorization = await authorizeStageRelease({
      projectId: facts.project.id,
      scope: "PROJECT",
      fromStageId: facts.firstStage.id,
      toStageId: nextStage.id,
      reason: "Authorize project-level parallel preparation",
      actorId: ids.admin,
      auditContext
    });
    const transitioned = await transitionProjectStage({
      projectId: facts.project.id,
      stageId: nextStage.id,
      toStatus: "AUTHORIZED",
      version: nextStage.version,
      reason: "Start released adjacent stage",
      actorId: ids.admin,
      auditContext
    });
    const revoked = await revokeStageRelease({
      projectId: facts.project.id,
      releaseId: authorization.release.stageReleaseAuthorizationId,
      version: authorization.resourceVersion,
      reason: "Parallel preparation is no longer needed",
      actorId: ids.admin,
      auditContext
    });

    expect(transitioned.stage).toMatchObject({ status: "AUTHORIZED", resourceVersion: 2 });
    expect(revoked.release).toMatchObject({ status: "REVOKED", version: 2 });
    await expect(
      transitionProjectStage({
        projectId: facts.project.id,
        stageId: nextStage.id,
        toStatus: "IN_PROGRESS",
        version: transitioned.resourceVersion,
        reason: "Do not start a stage after its release has been revoked",
        actorId: ids.admin,
        auditContext
      })
    ).rejects.toMatchObject({ code: "STAGE_RELEASE_REQUIRED" });
    await expect(
      db.auditLog.count({ where: { projectId: facts.project.id, action: "PROJECT_STAGE_UPDATED" } })
    ).resolves.toBe(1);
    await expect(
      db.outboxEvent.count({
        where: { aggregateId: nextStage.id, eventType: "project.stage.updated" }
      })
    ).resolves.toBe(1);
  });
});
