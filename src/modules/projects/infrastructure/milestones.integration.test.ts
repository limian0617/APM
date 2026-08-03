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

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `milestone-admin-${suffix}`
};

function context(actorId: string, operationId: string): AuditContext {
  return {
    actorId,
    requestId: `request-${operationId}`,
    traceId: `trace-${operationId}`,
    source: "API",
    sourceIp: null,
    userAgent: "Vitest",
    reason: null,
    projectId: null,
    departmentId: "engineering",
    operationId
  };
}

function componentDefinition(type: "STAGE" | "GATE" | "ROLE" | "WBS" | "MILESTONE") {
  switch (type) {
    case "STAGE":
      return { stages: [{ code: "S0", name: "项目启动", sequence: 0 }] };
    case "GATE":
      return {
        gates: [
          {
            code: "G1",
            name: "执行基线批准",
            stageCode: "S0",
            requiredCheckerCodes: ["DOCUMENTS.COMPLETE"]
          }
        ]
      };
    case "ROLE":
      return { roles: [{ code: "PROJECT_MANAGER", name: "项目经理", required: true }] };
    case "WBS":
      return {
        packages: [{ code: "S0.KICKOFF", name: "项目启动", stageCode: "S0", weight: 10 }]
      };
    case "MILESTONE":
      return { milestones: [{ code: "DESIGN.FREEZE", name: "设计冻结", position: 0 }] };
  }
}

async function seedPublishedTemplate(label: string) {
  const componentVersions = await Promise.all(
    (["STAGE", "GATE", "ROLE", "WBS", "MILESTONE"] as const).map(async (componentType) => {
      const code = `MILESTONE.${label}.${componentType}.${suffix}`.toUpperCase();
      const draft = await saveTemplateComponentDraft({
        code,
        componentType,
        name: `${componentType} milestone test component`,
        content: componentDefinition(componentType),
        version: 0,
        reason: "创建里程碑约束测试组件",
        actorId: ids.admin,
        auditContext: context(ids.admin, `component-draft-${label}-${componentType}-${suffix}`)
      });
      return (
        await publishTemplateComponent({
          code,
          version: draft.component.version,
          reason: "发布里程碑约束测试组件",
          actorId: ids.admin,
          auditContext: context(ids.admin, `component-publish-${label}-${componentType}-${suffix}`)
        })
      ).publishedVersion;
    })
  );
  const code = `MILESTONE.TEMPLATE.${label}.${suffix}`.toUpperCase();
  const draft = await saveProjectTemplateDraft({
    code,
    name: `${label} milestone test template`,
    components: componentVersions.map((componentVersion, position) => ({
      componentVersionId: componentVersion.id,
      componentType: componentVersion.componentType,
      slot: `${componentVersion.componentType}.${position}`,
      position
    })),
    version: 0,
    reason: "创建里程碑约束测试模板",
    actorId: ids.admin,
    auditContext: context(ids.admin, `template-draft-${label}-${suffix}`)
  });
  const published = await publishProjectTemplate({
    code,
    version: draft.template.version,
    reason: "发布里程碑约束测试模板",
    actorId: ids.admin,
    auditContext: context(ids.admin, `template-publish-${label}-${suffix}`)
  });
  return { code, ...published };
}

async function createSnapshotProject(
  template: Awaited<ReturnType<typeof seedPublishedTemplate>>,
  label: string
) {
  const project = (
    await createProjectFromTemplate({
      code: `P25.SNAPSHOT.${label}.${suffix}`.toUpperCase(),
      name: `${label} milestone snapshot project`,
      departmentId: "engineering",
      templateCode: template.code,
      templateVersion: template.publishedVersion.version,
      templateChecksum: template.publishedVersion.checksum,
      reason: "创建里程碑来源约束测试项目",
      actorId: ids.admin,
      auditContext: context(ids.admin, `snapshot-project-${label}-${suffix}`)
    })
  ).project;
  const snapshot = await db.projectTemplateSnapshot.findUniqueOrThrow({
    where: { projectId: project.id },
    include: { components: true }
  });
  return { project, snapshot };
}

async function seedProject(label: string) {
  const project = await db.project.create({
    data: {
      code: `P25.${label}.${suffix}`.toUpperCase(),
      name: `${label} milestone constraint project`,
      createdById: ids.admin
    }
  });
  const membership = await db.projectMember.create({
    data: {
      projectId: project.id,
      userId: ids.admin,
      projectRole: "PROJECT_MANAGER",
      departmentId: "engineering",
      assignedById: ids.admin
    }
  });
  const wbsNode = await db.wbsNode.create({
    data: {
      projectId: project.id,
      code: "ROOT",
      name: "Milestone test root",
      position: 0,
      createdById: ids.admin,
      updatedById: ids.admin
    }
  });
  const plannedStartAt = new Date("2026-08-03T00:00:00.000Z");
  const plannedFinishAt = new Date("2026-08-03T08:00:00.000Z");
  const task = await db.planningTask.create({
    data: {
      projectId: project.id,
      wbsNodeId: wbsNode.id,
      ownerMembershipId: membership.id,
      code: "PLAN",
      name: "Milestone test task",
      position: 0,
      plannedStartAt,
      plannedFinishAt,
      plannedDurationMinutes: 480,
      weight: 1,
      remainingDurationMinutes: 480,
      forecastFinishAt: plannedFinishAt,
      createdById: ids.admin,
      updatedById: ids.admin
    }
  });

  return { project, task };
}

describeDatabase("APM-025 PostgreSQL project milestone facts", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: ids.admin,
        employeeNo: `MILESTONE-ADMIN-${suffix}`,
        name: "Milestone administrator",
        departmentId: "engineering"
      }
    });
    await db.userRole.create({
      data: { id: `milestone-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" }
    });
  });

  it("accepts only a same-project MILESTONE snapshot component as milestone source", async () => {
    const template = await seedPublishedTemplate("SOURCE");
    const current = await createSnapshotProject(template, "CURRENT");
    const foreign = await createSnapshotProject(template, "FOREIGN");
    const currentMilestoneComponent = current.snapshot.components.find(
      ({ componentType }) => componentType === "MILESTONE"
    );
    const foreignMilestoneComponent = foreign.snapshot.components.find(
      ({ componentType }) => componentType === "MILESTONE"
    );
    const currentStageComponent = current.snapshot.components.find(
      ({ componentType }) => componentType === "STAGE"
    );
    expect(currentMilestoneComponent).toBeDefined();
    expect(foreignMilestoneComponent).toBeDefined();
    expect(currentStageComponent).toBeDefined();

    await expect(
      db.projectMilestone.create({
        data: {
          projectId: current.project.id,
          sourceSnapshotComponentId: foreignMilestoneComponent!.id,
          code: "FOREIGN.SOURCE",
          name: "Foreign source",
          position: 0,
          createdById: ids.admin,
          updatedById: ids.admin
        }
      })
    ).rejects.toThrow(/same project/u);
    await expect(
      db.projectMilestone.create({
        data: {
          projectId: current.project.id,
          sourceSnapshotComponentId: currentStageComponent!.id,
          code: "WRONG.TYPE",
          name: "Wrong source type",
          position: 1,
          createdById: ids.admin,
          updatedById: ids.admin
        }
      })
    ).rejects.toThrow(/milestone component/u);
    await expect(
      db.projectMilestone.create({
        data: {
          projectId: current.project.id,
          sourceSnapshotComponentId: currentMilestoneComponent!.id,
          code: "VALID.SOURCE",
          name: "Valid source",
          position: 2,
          createdById: ids.admin,
          updatedById: ids.admin
        }
      })
    ).resolves.toMatchObject({ sourceSnapshotComponentId: currentMilestoneComponent!.id });
  });

  it("rejects cross-project or duplicate task links and protects immutable milestone events", async () => {
    const current = await seedProject("CURRENT");
    const foreign = await seedProject("FOREIGN");
    const milestone = await db.projectMilestone.create({
      data: {
        projectId: current.project.id,
        code: "DESIGN.FREEZE",
        name: "Design freeze",
        position: 10,
        createdById: ids.admin,
        updatedById: ids.admin
      }
    });
    const event = await db.projectMilestoneEvent.create({
      data: {
        projectId: current.project.id,
        milestoneId: milestone.id,
        sequence: 1,
        eventType: "CREATED",
        fromStatus: null,
        toStatus: "PENDING",
        reason: "Create milestone fact",
        snapshotJson: { status: "PENDING" },
        actorId: ids.admin
      }
    });

    await expect(
      db.projectMilestoneTaskLink.create({
        data: {
          projectId: current.project.id,
          milestoneId: milestone.id,
          taskId: foreign.task.id,
          status: "ACTIVE",
          createdById: ids.admin
        }
      })
    ).rejects.toThrow(/same project/u);

    await db.projectMilestoneTaskLink.create({
      data: {
        projectId: current.project.id,
        milestoneId: milestone.id,
        taskId: current.task.id,
        status: "ACTIVE",
        createdById: ids.admin
      }
    });
    await expect(
      db.projectMilestoneTaskLink.create({
        data: {
          projectId: current.project.id,
          milestoneId: milestone.id,
          taskId: current.task.id,
          status: "ACTIVE",
          createdById: ids.admin
        }
      })
    ).rejects.toMatchObject({ code: "P2002" });

    await expect(
      db.projectMilestoneTaskLink.create({
        data: {
          projectId: current.project.id,
          milestoneId: milestone.id,
          taskId: current.task.id,
          status: "VOID",
          createdById: ids.admin,
          voidedById: ids.admin,
          voidedAt: new Date(),
          voidReason: null
        }
      })
    ).rejects.toThrow(/project_milestone_task_links_void_check/u);

    await expect(
      db.projectMilestoneEvent.update({
        where: { id: event.id },
        data: { reason: "tampered" }
      })
    ).rejects.toThrow(/append-only/u);
    await expect(db.projectMilestoneEvent.delete({ where: { id: event.id } })).rejects.toThrow(
      /append-only/u
    );
    await expect(db.$executeRawUnsafe('TRUNCATE TABLE "project_milestone_events"')).rejects.toThrow(
      /append-only/u
    );
  });
});
