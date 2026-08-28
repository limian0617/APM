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
  linkMilestoneTask,
  manuallyAchieveProjectMilestone,
  updateProjectMilestone,
  voidMilestoneTaskLink,
  voidProjectMilestone
} from "@/modules/projects/application/milestone-service";
import { POST as commandMilestoneRoute } from "../../../app/api/projects/[projectId]/milestones/[milestoneId]/[command]/route";
import { GET as readMilestoneRoute } from "../../../app/api/projects/[projectId]/milestones/[milestoneId]/route";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `milestone-admin-${suffix}`,
  outsider: `milestone-outsider-${suffix}`
};

function commandRequest(url: string, body: unknown, key: string, actorId: string) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-apm-user-id": actorId,
      "idempotency-key": key,
      "x-request-id": `request-${key}`
    },
    body: JSON.stringify(body)
  });
}

function readRequest(url: string, actorId: string) {
  return new Request(url, { headers: { "x-apm-user-id": actorId } });
}

function context(
  actorId: string,
  operationId: string,
  projectId: string | null = null
): AuditContext {
  return {
    actorId,
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

async function createReadySnapshotProject(
  template: Awaited<ReturnType<typeof seedPublishedTemplate>>,
  label: string
) {
  const { project: createdProject, snapshot } = await createSnapshotProject(template, label);
  const structure = await initializeProjectStructure({
    projectId: createdProject.id,
    projectVersion: createdProject.version,
    projectType: "CUSTOMER_DELIVERY",
    equipmentShape: "SINGLE_MACHINE",
    deliveryUnits: [
      {
        code: "MACHINE.01",
        name: "里程碑测试单机",
        unitType: "MACHINE",
        parentCode: null,
        position: 0
      }
    ],
    modules: [
      { code: "MODULE.01", name: "里程碑测试模块", machineCode: "MACHINE.01", position: 0 }
    ],
    reason: "初始化里程碑测试项目结构",
    actorId: ids.admin,
    auditContext: context(ids.admin, `snapshot-structure-${label}-${suffix}`, createdProject.id)
  });
  const membership = await db.projectMember.findFirstOrThrow({
    where: { projectId: createdProject.id, userId: ids.admin, leftAt: null }
  });
  const wbsNode = await db.wbsNode.create({
    data: {
      projectId: createdProject.id,
      code: "MILESTONE.ROOT",
      name: "里程碑测试根节点",
      position: 0,
      createdById: ids.admin,
      updatedById: ids.admin
    }
  });
  const task = await db.planningTask.create({
    data: {
      projectId: createdProject.id,
      wbsNodeId: wbsNode.id,
      ownerMembershipId: membership.id,
      code: "MILESTONE.TASK",
      name: "里程碑关联测试任务",
      position: 0,
      plannedStartAt: new Date("2026-08-03T00:00:00.000Z"),
      plannedFinishAt: new Date("2026-08-03T08:00:00.000Z"),
      plannedDurationMinutes: 480,
      weight: 1,
      remainingDurationMinutes: 480,
      forecastFinishAt: new Date("2026-08-03T08:00:00.000Z"),
      createdById: ids.admin,
      updatedById: ids.admin
    }
  });
  const project = await db.project.findUniqueOrThrow({ where: { id: createdProject.id } });
  return { project, snapshot, structure, task };
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
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `MILESTONE-ADMIN-${suffix}`,
          name: "Milestone administrator",
          departmentId: "engineering"
        },
        {
          id: ids.outsider,
          employeeNo: `MILESTONE-OUTSIDER-${suffix}`,
          name: "Milestone outsider",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `milestone-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        {
          id: `milestone-role-outsider-${suffix}`,
          userId: ids.outsider,
          roleId: "role-engineer"
        }
      ]
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

  it("guards milestone commands and binds idempotency keys to the full command body", async () => {
    const template = await seedPublishedTemplate("API");
    const ready = await createReadySnapshotProject(template, "API");
    const other = await createReadySnapshotProject(template, "API-OTHER");
    const milestone = await db.projectMilestone.findFirstOrThrow({
      where: { projectId: ready.project.id, code: "DESIGN.FREEZE" }
    });
    const commandUrl = `http://localhost/api/projects/${ready.project.id}/milestones/${milestone.id}/achieve`;
    const commandContext = {
      params: Promise.resolve({
        projectId: ready.project.id,
        milestoneId: milestone.id,
        command: "achieve"
      })
    };

    const forbidden = await commandMilestoneRoute(
      commandRequest(
        commandUrl,
        { version: milestone.version, reason: "越权尝试" },
        `milestone-forbidden-${suffix}`,
        ids.outsider
      ),
      commandContext
    );
    expect(forbidden.status).toBe(403);

    const idempotencyKey = `milestone-achieve-${suffix}`;
    const body = { version: milestone.version, reason: "PM 确认设计冻结" };
    const first = await commandMilestoneRoute(
      commandRequest(commandUrl, body, idempotencyKey, ids.admin),
      commandContext
    );
    const replay = await commandMilestoneRoute(
      commandRequest(commandUrl, body, idempotencyKey, ids.admin),
      commandContext
    );
    const conflictingPayload = await commandMilestoneRoute(
      commandRequest(
        commandUrl,
        { ...body, reason: "同一幂等键的不同确认原因" },
        idempotencyKey,
        ids.admin
      ),
      commandContext
    );
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(conflictingPayload.status).toBe(409);
    await expect(conflictingPayload.json()).resolves.toMatchObject({
      error: { code: "IDEMPOTENCY_KEY_REUSED" }
    });

    const crossProjectRead = await readMilestoneRoute(
      readRequest(
        `http://localhost/api/projects/${other.project.id}/milestones/${milestone.id}`,
        ids.admin
      ),
      { params: Promise.resolve({ projectId: other.project.id, milestoneId: milestone.id }) }
    );
    expect(crossProjectRead.status).toBe(404);
  });

  it("copies template milestones, preserves durable history, and rolls failed link commands back", async () => {
    const template = await seedPublishedTemplate("LIFECYCLE");
    const ready = await createReadySnapshotProject(template, "LIFECYCLE");
    const milestone = await db.projectMilestone.findFirstOrThrow({
      where: { projectId: ready.project.id, code: "DESIGN.FREEZE" }
    });
    expect(milestone.sourceSnapshotComponentId).not.toBeNull();
    await expect(
      db.projectMilestoneEvent.findMany({
        where: { milestoneId: milestone.id },
        orderBy: { sequence: "asc" }
      })
    ).resolves.toMatchObject([{ sequence: 1, eventType: "CREATED", toStatus: "PENDING" }]);

    const sourceComponentVersion = await db.templateComponentVersion.findUniqueOrThrow({
      where: {
        id: ready.snapshot.components.find(({ componentType }) => componentType === "MILESTONE")!
          .sourceComponentVersionId
      },
      include: { component: true }
    });
    const revisedComponent = await saveTemplateComponentDraft({
      code: sourceComponentVersion.component.code,
      componentType: "MILESTONE",
      name: "已更新的里程碑模板组件",
      content: { milestones: [{ code: "DESIGN.FREEZE", name: "更新后的模板名称", position: 0 }] },
      version: sourceComponentVersion.component.version,
      reason: "更新模板里程碑定义",
      actorId: ids.admin,
      auditContext: context(ids.admin, `template-component-update-${suffix}`)
    });
    const publishedComponent = await publishTemplateComponent({
      code: sourceComponentVersion.component.code,
      version: revisedComponent.component.version,
      reason: "发布更新后的模板里程碑定义",
      actorId: ids.admin,
      auditContext: context(ids.admin, `template-component-republish-${suffix}`)
    });
    const currentTemplate = await db.projectTemplate.findUniqueOrThrow({
      where: { code: template.code }
    });
    const sourceTemplate = await db.projectTemplateVersion.findUniqueOrThrow({
      where: { id: template.publishedVersion.id },
      include: { components: true }
    });
    const revisedTemplate = await saveProjectTemplateDraft({
      code: template.code,
      name: currentTemplate.name,
      description: currentTemplate.description,
      version: currentTemplate.version,
      reason: "模板引用新发布的里程碑组件版本",
      actorId: ids.admin,
      auditContext: context(ids.admin, `template-update-${suffix}`),
      components: sourceTemplate.components.map((reference) => ({
        componentVersionId:
          reference.componentType === "MILESTONE"
            ? publishedComponent.publishedVersion.id
            : reference.componentVersionId,
        componentType: reference.componentType,
        slot: reference.slot,
        position: reference.position
      }))
    });
    await publishProjectTemplate({
      code: template.code,
      version: revisedTemplate.template.version,
      reason: "发布更新后的模板版本",
      actorId: ids.admin,
      auditContext: context(ids.admin, `template-republish-${suffix}`)
    });
    await expect(
      db.projectMilestone.findUniqueOrThrow({ where: { id: milestone.id } })
    ).resolves.toMatchObject({
      name: "设计冻结",
      sourceSnapshotComponentId: milestone.sourceSnapshotComponentId
    });

    const achieved = await manuallyAchieveProjectMilestone({
      projectId: ready.project.id,
      milestoneId: milestone.id,
      version: milestone.version,
      reason: "PM 手动确认设计冻结",
      actorId: ids.admin,
      auditContext: context(ids.admin, `manual-achievement-${suffix}`, ready.project.id)
    });
    expect(achieved).toMatchObject({
      milestone: { status: "ACHIEVED", achievementSource: "MANUAL" },
      event: { sequence: 2, eventType: "ACHIEVED_MANUALLY" }
    });
    await expect(
      updateProjectMilestone({
        projectId: ready.project.id,
        milestoneId: milestone.id,
        version: milestone.version,
        name: "使用过期版本修改的设计冻结",
        position: milestone.position,
        reason: "使用过期版本修改",
        actorId: ids.admin,
        auditContext: context(ids.admin, `stale-update-${suffix}`, ready.project.id)
      })
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });

    const beforeFailure = await Promise.all([
      db.projectMilestoneEvent.count({ where: { milestoneId: milestone.id } }),
      db.auditLog.count({ where: { objectId: milestone.id } }),
      db.outboxEvent.count({ where: { aggregateId: milestone.id } })
    ]);
    await expect(
      linkMilestoneTask({
        projectId: ready.project.id,
        milestoneId: milestone.id,
        version: achieved.resourceVersion,
        taskId: ready.task.id,
        reason: "故意使用不存在的操作者验证事务回滚",
        actorId: `missing-milestone-actor-${suffix}`,
        auditContext: context(
          `missing-milestone-actor-${suffix}`,
          `rollback-link-${suffix}`,
          ready.project.id
        )
      })
    ).rejects.toMatchObject({ code: "MILESTONE_RELATION_INVALID", status: 409 });
    await expect(
      Promise.all([
        db.projectMilestoneEvent.count({ where: { milestoneId: milestone.id } }),
        db.auditLog.count({ where: { objectId: milestone.id } }),
        db.outboxEvent.count({ where: { aggregateId: milestone.id } })
      ])
    ).resolves.toEqual(beforeFailure);
    await expect(
      db.projectMilestone.findUniqueOrThrow({ where: { id: milestone.id } })
    ).resolves.toMatchObject({
      version: achieved.resourceVersion,
      status: "ACHIEVED"
    });

    const firstLink = await linkMilestoneTask({
      projectId: ready.project.id,
      milestoneId: milestone.id,
      version: achieved.resourceVersion,
      taskId: ready.task.id,
      reason: "关联设计冻结的验证任务",
      actorId: ids.admin,
      auditContext: context(ids.admin, `link-task-${suffix}`, ready.project.id)
    });
    const voidedLink = await voidMilestoneTaskLink({
      projectId: ready.project.id,
      milestoneId: milestone.id,
      linkId: firstLink.link.id,
      version: firstLink.resourceVersion,
      reason: "PM 作废原有任务关联",
      actorId: ids.admin,
      auditContext: context(ids.admin, `void-link-${suffix}`, ready.project.id)
    });
    const relinked = await linkMilestoneTask({
      projectId: ready.project.id,
      milestoneId: milestone.id,
      version: voidedLink.resourceVersion,
      taskId: ready.task.id,
      reason: "PM 重新关联同一任务",
      actorId: ids.admin,
      auditContext: context(ids.admin, `relink-task-${suffix}`, ready.project.id)
    });
    await expect(
      db.projectMilestoneTaskLink.findMany({
        where: { milestoneId: milestone.id, taskId: ready.task.id },
        orderBy: { createdAt: "asc" }
      })
    ).resolves.toMatchObject([{ status: "VOID" }, { status: "ACTIVE" }]);
    await expect(
      db.auditLog.findMany({
        where: {
          objectId: milestone.id,
          action: { in: ["PROJECT_MILESTONE_TASK_LINKED", "PROJECT_MILESTONE_TASK_LINK_VOIDED"] }
        },
        orderBy: { occurredAt: "asc" }
      })
    ).resolves.toMatchObject([
      { metadataJson: { taskId: ready.task.id, taskLinkStatus: "ACTIVE" } },
      {
        metadataJson: {
          taskId: ready.task.id,
          taskLinkStatus: "VOID",
          voidReason: "PM 作废原有任务关联"
        }
      },
      { metadataJson: { taskId: ready.task.id, taskLinkStatus: "ACTIVE" } }
    ]);

    const voided = await voidProjectMilestone({
      projectId: ready.project.id,
      milestoneId: milestone.id,
      version: relinked.resourceVersion,
      reason: "PM 作废已替代的里程碑",
      actorId: ids.admin,
      auditContext: context(ids.admin, `void-milestone-${suffix}`, ready.project.id)
    });
    expect(voided).toMatchObject({
      milestone: { status: "VOID" },
      event: { sequence: 6, eventType: "VOIDED" }
    });
    await expect(
      db.projectMilestone.findUniqueOrThrow({ where: { id: milestone.id } })
    ).resolves.toMatchObject({
      status: "VOID"
    });
  });
});
