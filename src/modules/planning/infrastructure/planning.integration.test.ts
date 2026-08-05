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
import {
  createProjectMilestone,
  linkMilestoneTask
} from "@/modules/projects/application/milestone-service";
import { createResponsibilityPackage } from "@/modules/projects/application/responsibility-package-service";
import { initializeProjectStructure } from "@/modules/projects/application/project-structure";

import {
  closePlanningTask,
  createPlanningTask,
  createWbsNode,
  updatePlanningTask,
  updatePlanningTaskProgress
} from "../application/planning-service";
import { saveProjectCalendar } from "../application/schedule-network-service";
import { GET as readExecutionRoute } from "../../../app/api/projects/[projectId]/execution/route";
import {
  GET as listWbsRoute,
  POST as createWbsRoute
} from "../../../app/api/projects/[projectId]/wbs-nodes/route";
import { PUT as updateWbsRoute } from "../../../app/api/projects/[projectId]/wbs-nodes/[nodeId]/route";
import { POST as closeWbsRoute } from "../../../app/api/projects/[projectId]/wbs-nodes/[nodeId]/close/route";
import {
  GET as listTasksRoute,
  POST as createTaskRoute
} from "../../../app/api/projects/[projectId]/tasks/route";
import { GET as readTaskRoute } from "../../../app/api/projects/[projectId]/tasks/[taskId]/route";
import { POST as commandTaskRoute } from "../../../app/api/projects/[projectId]/tasks/[taskId]/[command]/route";

const databaseEnabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const describeDatabase = databaseEnabled ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `planning-admin-${suffix}`,
  owner: `planning-owner-${suffix}`,
  outsider: `planning-outsider-${suffix}`
};

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
    sourceIp: "127.0.0.1",
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
      return { packages: [{ code: "S0.KICKOFF", name: "项目启动", stageCode: "S0", weight: 10 }] };
  }
}

async function seedPublishedTemplate() {
  const versions = await Promise.all(
    (["STAGE", "GATE", "ROLE", "WBS"] as const).map(async (componentType) => {
      const code = `PLANNING.${componentType}.${suffix}`.toUpperCase();
      const draft = await saveTemplateComponentDraft({
        code,
        componentType,
        name: `${componentType} planning test`,
        content: componentDefinition(componentType),
        version: 0,
        reason: "创建计划测试组件",
        actorId: ids.admin,
        auditContext: context(ids.admin, `component-draft-${componentType}-${suffix}`)
      });
      return (
        await publishTemplateComponent({
          code,
          version: draft.component.version,
          reason: "发布计划测试组件",
          actorId: ids.admin,
          auditContext: context(ids.admin, `component-publish-${componentType}-${suffix}`)
        })
      ).publishedVersion;
    })
  );
  const code = `PLANNING.TEMPLATE.${suffix}`.toUpperCase();
  const draft = await saveProjectTemplateDraft({
    code,
    name: "计划测试模板",
    components: versions.map((version, position) => ({
      componentVersionId: version.id,
      componentType: version.componentType,
      slot: `${version.componentType}.${position}`,
      position
    })),
    version: 0,
    reason: "创建计划测试模板",
    actorId: ids.admin,
    auditContext: context(ids.admin, `template-draft-${suffix}`)
  });
  return {
    code,
    ...(await publishProjectTemplate({
      code,
      version: draft.template.version,
      reason: "发布计划测试模板",
      actorId: ids.admin,
      auditContext: context(ids.admin, `template-publish-${suffix}`)
    }))
  };
}

function postRequest(url: string, body: unknown, key: string, actorId = ids.admin) {
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

function putRequest(url: string, body: unknown, key: string, actorId = ids.admin) {
  return new Request(url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-apm-user-id": actorId,
      "idempotency-key": key,
      "x-request-id": `request-${key}`
    },
    body: JSON.stringify(body)
  });
}

function readRequest(url: string, actorId?: string) {
  return new Request(url, { headers: actorId ? { "x-apm-user-id": actorId } : undefined });
}

describeDatabase("APM-020 PostgreSQL WBS and planning tasks", () => {
  let template: Awaited<ReturnType<typeof seedPublishedTemplate>>;
  let projectSequence = 0;

  async function createReadyProject(label: string) {
    projectSequence += 1;
    const project = (
      await createProjectFromTemplate({
        code: `P20.${label}.${projectSequence}.${suffix}`.toUpperCase(),
        name: `${label} planning project`,
        departmentId: "engineering",
        templateCode: template.code,
        templateVersion: template.publishedVersion.version,
        templateChecksum: template.publishedVersion.checksum,
        reason: "创建计划测试项目",
        actorId: ids.admin,
        auditContext: context(ids.admin, `project-${label}-${projectSequence}-${suffix}`)
      })
    ).project;
    const structure = await initializeProjectStructure({
      projectId: project.id,
      projectVersion: project.version,
      projectType: "CUSTOMER_DELIVERY",
      equipmentShape: "SINGLE_MACHINE",
      deliveryUnits: [
        {
          code: "MACHINE.01",
          name: "一号单机",
          unitType: "MACHINE",
          parentCode: null,
          position: 0
        }
      ],
      modules: [{ code: "MODULE.01", name: "设计模块", machineCode: "MACHINE.01", position: 0 }],
      reason: "初始化计划测试结构",
      actorId: ids.admin,
      auditContext: context(
        ids.admin,
        `structure-${label}-${projectSequence}-${suffix}`,
        project.id
      )
    });
    const ownerMembership = await db.projectMember.create({
      data: {
        projectId: project.id,
        userId: ids.owner,
        projectRole: "ENGINEER",
        departmentId: "engineering",
        assignedById: ids.admin
      }
    });
    const responsibilityPackage = await createResponsibilityPackage({
      projectId: project.id,
      code: "MECH.DESIGN",
      name: "机械设计责任包",
      deliveryUnitId: structure.deliveryUnits[0]!.id,
      moduleId: structure.modules[0]!.id,
      ownerMembershipId: ownerMembership.id,
      inputs: [{ code: "REQUIREMENT", description: "冻结需求" }],
      outputs: [{ code: "DRAWING", description: "受控图纸" }],
      acceptanceCriteria: [{ code: "REVIEWED", description: "评审通过" }],
      valueWeight: 25,
      reason: "创建计划测试责任包",
      actorId: ids.admin,
      auditContext: context(ids.admin, `package-${label}-${projectSequence}-${suffix}`, project.id)
    });
    return { project, structure, ownerMembership, responsibilityPackage };
  }

  function wbsBody(code = "DESIGN", parentId: string | null = null, position = 0) {
    return { code, name: `${code} WBS`, description: null, parentId, position, reason: "维护WBS" };
  }

  function taskBody(ready: Awaited<ReturnType<typeof createReadyProject>>, wbsNodeId: string) {
    return {
      code: "MECH.DESIGN.01",
      name: "机械详细设计",
      description: "输出受控机械图纸",
      wbsNodeId,
      responsibilityPackageId: ready.responsibilityPackage.responsibilityPackage.packageId,
      deliveryUnitId: ready.structure.deliveryUnits[0]!.id,
      moduleId: ready.structure.modules[0]!.id,
      ownerMembershipId: ready.ownerMembership.id,
      position: 0,
      plannedStartAt: "2026-08-03T00:00:00.000Z",
      plannedFinishAt: "2026-08-10T00:00:00.000Z",
      plannedDurationMinutes: 2400,
      weight: 25,
      reason: "创建机械设计任务"
    };
  }

  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `PLANNING-ADMIN-${suffix}`,
          name: "计划管理员",
          departmentId: "engineering"
        },
        {
          id: ids.owner,
          employeeNo: `PLANNING-OWNER-${suffix}`,
          name: "任务负责人",
          departmentId: "engineering"
        },
        {
          id: ids.outsider,
          employeeNo: `PLANNING-OUTSIDER-${suffix}`,
          name: "非项目成员",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `planning-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        { id: `planning-role-owner-${suffix}`, userId: ids.owner, roleId: "role-engineer" },
        { id: `planning-role-outsider-${suffix}`, userId: ids.outsider, roleId: "role-engineer" }
      ]
    });
    template = await seedPublishedTemplate();
  });

  it("creates, replays, reads, updates, and closes an acyclic WBS tree", async () => {
    const ready = await createReadyProject("WBS");
    const url = `http://localhost/api/projects/${ready.project.id}/wbs-nodes`;
    const rootResponse = await createWbsRoute(postRequest(url, wbsBody(), `wbs-root-${suffix}`), {
      params: Promise.resolve({ projectId: ready.project.id })
    });
    const rootBody = (await rootResponse.json()) as {
      wbsNode: { nodeId: string; resourceVersion: number };
    };
    const replay = await createWbsRoute(postRequest(url, wbsBody(), `wbs-root-${suffix}`), {
      params: Promise.resolve({ projectId: ready.project.id })
    });
    expect(rootResponse.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");

    const childResponse = await createWbsRoute(
      postRequest(url, wbsBody("DESIGN.MECH", rootBody.wbsNode.nodeId), `wbs-child-${suffix}`),
      { params: Promise.resolve({ projectId: ready.project.id }) }
    );
    const childBody = (await childResponse.json()) as { wbsNode: { nodeId: string } };
    const rootDetailUrl = `${url}/${rootBody.wbsNode.nodeId}`;
    const { code: _code, ...cycleDefinition } = wbsBody("IGNORED", childBody.wbsNode.nodeId);
    const cycleBody = {
      ...cycleDefinition,
      version: rootBody.wbsNode.resourceVersion
    };
    expect(
      (
        await updateWbsRoute(putRequest(rootDetailUrl, cycleBody, `wbs-cycle-${suffix}`), {
          params: Promise.resolve({ projectId: ready.project.id, nodeId: rootBody.wbsNode.nodeId })
        })
      ).status
    ).toBe(409);
    expect(
      (
        await closeWbsRoute(
          postRequest(
            rootDetailUrl + "/close",
            { version: 1, reason: "关闭根节点" },
            `close-root-${suffix}`
          ),
          {
            params: Promise.resolve({
              projectId: ready.project.id,
              nodeId: rootBody.wbsNode.nodeId
            })
          }
        )
      ).status
    ).toBe(409);
    expect(
      (
        await listWbsRoute(readRequest(url, ids.outsider), {
          params: Promise.resolve({ projectId: ready.project.id })
        })
      ).status
    ).toBe(403);
    expect(
      (
        await closeWbsRoute(
          postRequest(
            `${url}/${childBody.wbsNode.nodeId}/close`,
            { version: 1, reason: "关闭子节点" },
            `close-child-${suffix}`
          ),
          {
            params: Promise.resolve({
              projectId: ready.project.id,
              nodeId: childBody.wbsNode.nodeId
            })
          }
        )
      ).status
    ).toBe(200);
  });

  it("creates an idempotent task and rejects cross-project relations and IDOR", async () => {
    const ready = await createReadyProject("TASK");
    const other = await createReadyProject("TASK-OTHER");
    const wbs = await createWbsNode({
      projectId: ready.project.id,
      ...wbsBody("EXECUTION"),
      actorId: ids.admin,
      auditContext: context(ids.admin, `create-task-wbs-${suffix}`, ready.project.id)
    });
    const url = `http://localhost/api/projects/${ready.project.id}/tasks`;
    const body = taskBody(ready, wbs.wbsNode.nodeId);
    const first = await createTaskRoute(postRequest(url, body, `create-task-${suffix}`), {
      params: Promise.resolve({ projectId: ready.project.id })
    });
    const firstBody = (await first.json()) as { task: { taskId: string; status: string } };
    const replay = await createTaskRoute(postRequest(url, body, `create-task-${suffix}`), {
      params: Promise.resolve({ projectId: ready.project.id })
    });
    expect(first.status).toBe(201);
    expect(firstBody.task.status).toBe("NOT_STARTED");
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(
      (
        await readTaskRoute(readRequest(`${url}/${firstBody.task.taskId}`, ids.owner), {
          params: Promise.resolve({ projectId: ready.project.id, taskId: firstBody.task.taskId })
        })
      ).status
    ).toBe(200);
    expect(
      (
        await listTasksRoute(readRequest(url, ids.outsider), {
          params: Promise.resolve({ projectId: ready.project.id })
        })
      ).status
    ).toBe(403);
    await expect(
      createPlanningTask({
        projectId: ready.project.id,
        ...taskBody(ready, wbs.wbsNode.nodeId),
        code: "CROSS.OWNER",
        ownerMembershipId: other.ownerMembership.id,
        actorId: ids.admin,
        auditContext: context(ids.admin, `cross-owner-${suffix}`, ready.project.id)
      })
    ).rejects.toMatchObject({ code: "TASK_OWNER_INVALID", status: 409 });
  });

  it("allows only the assigned Owner to report progress and resolves concurrency by version", async () => {
    const ready = await createReadyProject("PROGRESS");
    const wbs = await createWbsNode({
      projectId: ready.project.id,
      ...wbsBody("COMMISSIONING"),
      actorId: ids.admin,
      auditContext: context(ids.admin, `progress-wbs-${suffix}`, ready.project.id)
    });
    const created = await createPlanningTask({
      projectId: ready.project.id,
      ...taskBody(ready, wbs.wbsNode.nodeId),
      actorId: ids.admin,
      auditContext: context(ids.admin, `progress-task-${suffix}`, ready.project.id)
    });
    const taskId = created.task.taskId;
    const url = `http://localhost/api/projects/${ready.project.id}/tasks/${taskId}/progress`;
    const progress = {
      version: 1,
      actualStartAt: "2026-08-04T00:00:00.000Z",
      remainingDurationMinutes: 1200,
      forecastFinishAt: "2026-08-11T00:00:00.000Z",
      reason: "更新任务进度"
    };
    expect(
      (
        await commandTaskRoute(
          postRequest(url, progress, `outsider-progress-${suffix}`, ids.outsider),
          {
            params: Promise.resolve({ projectId: ready.project.id, taskId, command: "progress" })
          }
        )
      ).status
    ).toBe(403);
    const started = await commandTaskRoute(
      postRequest(url, progress, `owner-progress-${suffix}`, ids.owner),
      { params: Promise.resolve({ projectId: ready.project.id, taskId, command: "progress" }) }
    );
    expect(await started.json()).toMatchObject({
      task: { status: "IN_PROGRESS", remainingDurationMinutes: 1200 },
      resourceVersion: 2
    });
    const outcomes = await Promise.all([
      commandTaskRoute(
        postRequest(
          url,
          { ...progress, version: 2, remainingDurationMinutes: 900 },
          `concurrent-a-${suffix}`,
          ids.owner
        ),
        { params: Promise.resolve({ projectId: ready.project.id, taskId, command: "progress" }) }
      ),
      commandTaskRoute(
        postRequest(
          url,
          { ...progress, version: 2, remainingDurationMinutes: 600 },
          `concurrent-b-${suffix}`,
          ids.owner
        ),
        { params: Promise.resolve({ projectId: ready.project.id, taskId, command: "progress" }) }
      )
    ]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual([200, 409]);
  });

  it("achieves a pending milestone exactly once only after every active linked task completes", async () => {
    const ready = await createReadyProject("MILESTONE-RECONCILE");
    const wbs = await createWbsNode({
      projectId: ready.project.id,
      ...wbsBody("MILESTONE-RECONCILE"),
      actorId: ids.admin,
      auditContext: context(ids.admin, `milestone-reconcile-wbs-${suffix}`, ready.project.id)
    });
    const firstTask = await createPlanningTask({
      projectId: ready.project.id,
      ...taskBody(ready, wbs.wbsNode.nodeId),
      code: "MILESTONE.RECONCILE.FIRST",
      actorId: ids.admin,
      auditContext: context(ids.admin, `milestone-reconcile-first-${suffix}`, ready.project.id)
    });
    const secondTask = await createPlanningTask({
      projectId: ready.project.id,
      ...taskBody(ready, wbs.wbsNode.nodeId),
      code: "MILESTONE.RECONCILE.SECOND",
      position: 1,
      actorId: ids.admin,
      auditContext: context(ids.admin, `milestone-reconcile-second-${suffix}`, ready.project.id)
    });
    const milestone = await createProjectMilestone({
      projectId: ready.project.id,
      code: "EXECUTION.COMPLETE",
      name: "执行完成",
      position: 10,
      reason: "创建任务完成里程碑",
      actorId: ids.admin,
      auditContext: context(ids.admin, `milestone-reconcile-create-${suffix}`, ready.project.id)
    });
    const firstLink = await linkMilestoneTask({
      projectId: ready.project.id,
      milestoneId: milestone.milestone.id,
      version: milestone.resourceVersion,
      taskId: firstTask.task.taskId,
      reason: "关联首项任务",
      actorId: ids.admin,
      auditContext: context(ids.admin, `milestone-reconcile-link-first-${suffix}`, ready.project.id)
    });
    await linkMilestoneTask({
      projectId: ready.project.id,
      milestoneId: milestone.milestone.id,
      version: firstLink.resourceVersion,
      taskId: secondTask.task.taskId,
      reason: "关联第二项任务",
      actorId: ids.admin,
      auditContext: context(
        ids.admin,
        `milestone-reconcile-link-second-${suffix}`,
        ready.project.id
      )
    });

    await updatePlanningTaskProgress({
      projectId: ready.project.id,
      taskId: firstTask.task.taskId,
      version: firstTask.resourceVersion,
      actualStartAt: "2026-08-04T00:00:00.000Z",
      actualFinishAt: "2026-08-09T00:00:00.000Z",
      remainingDurationMinutes: 0,
      forecastFinishAt: "2026-08-09T00:00:00.000Z",
      reason: "首项关联任务完成",
      actorId: ids.owner,
      auditContext: context(
        ids.owner,
        `milestone-reconcile-progress-first-${suffix}`,
        ready.project.id
      )
    });
    await expect(
      db.projectMilestone.findUniqueOrThrow({ where: { id: milestone.milestone.id } })
    ).resolves.toMatchObject({ status: "PENDING", achievementSource: null });

    await updatePlanningTaskProgress({
      projectId: ready.project.id,
      taskId: secondTask.task.taskId,
      version: secondTask.resourceVersion,
      actualStartAt: "2026-08-04T00:00:00.000Z",
      actualFinishAt: "2026-08-09T00:00:00.000Z",
      remainingDurationMinutes: 0,
      forecastFinishAt: "2026-08-09T00:00:00.000Z",
      reason: "第二项关联任务完成",
      actorId: ids.owner,
      auditContext: context(
        ids.owner,
        `milestone-reconcile-progress-second-${suffix}`,
        ready.project.id
      )
    });
    const achieved = await db.projectMilestone.findUniqueOrThrow({
      where: { id: milestone.milestone.id },
      include: { events: { orderBy: { sequence: "asc" } } }
    });
    expect(achieved).toMatchObject({
      status: "ACHIEVED",
      achievementSource: "LINKED_TASKS"
    });
    expect(achieved.events.at(-1)).toMatchObject({
      sequence: 4,
      eventType: "ACHIEVED_FROM_LINKED_TASKS"
    });

    await updatePlanningTaskProgress({
      projectId: ready.project.id,
      taskId: secondTask.task.taskId,
      version: secondTask.resourceVersion + 1,
      actualStartAt: "2026-08-04T00:00:00.000Z",
      actualFinishAt: "2026-08-09T00:00:00.000Z",
      remainingDurationMinutes: 0,
      forecastFinishAt: "2026-08-09T00:00:00.000Z",
      reason: "重复上报不重复达成",
      actorId: ids.owner,
      auditContext: context(ids.owner, `milestone-reconcile-repeat-${suffix}`, ready.project.id)
    });
    await expect(
      db.projectMilestoneEvent.count({
        where: { milestoneId: milestone.milestone.id, eventType: "ACHIEVED_FROM_LINKED_TASKS" }
      })
    ).resolves.toBe(1);

    const rollbackTask = await createPlanningTask({
      projectId: ready.project.id,
      ...taskBody(ready, wbs.wbsNode.nodeId),
      code: "MILESTONE.RECONCILE.ROLLBACK",
      position: 2,
      actorId: ids.admin,
      auditContext: context(
        ids.admin,
        `milestone-reconcile-rollback-task-${suffix}`,
        ready.project.id
      )
    });
    const rollbackMilestone = await createProjectMilestone({
      projectId: ready.project.id,
      code: "EXECUTION.ROLLBACK",
      name: "回滚验证里程碑",
      position: 20,
      reason: "创建回滚验证里程碑",
      actorId: ids.admin,
      auditContext: context(
        ids.admin,
        `milestone-reconcile-rollback-create-${suffix}`,
        ready.project.id
      )
    });
    await linkMilestoneTask({
      projectId: ready.project.id,
      milestoneId: rollbackMilestone.milestone.id,
      version: rollbackMilestone.resourceVersion,
      taskId: rollbackTask.task.taskId,
      reason: "关联回滚验证任务",
      actorId: ids.admin,
      auditContext: context(
        ids.admin,
        `milestone-reconcile-rollback-link-${suffix}`,
        ready.project.id
      )
    });
    await expect(
      db.$transaction(async (transaction) => {
        await updatePlanningTaskProgress(
          {
            projectId: ready.project.id,
            taskId: rollbackTask.task.taskId,
            version: rollbackTask.resourceVersion,
            actualStartAt: "2026-08-04T00:00:00.000Z",
            actualFinishAt: "2026-08-09T00:00:00.000Z",
            remainingDurationMinutes: 0,
            forecastFinishAt: "2026-08-09T00:00:00.000Z",
            reason: "触发事务回滚",
            actorId: ids.owner,
            auditContext: context(
              ids.owner,
              `milestone-reconcile-rollback-progress-${suffix}`,
              ready.project.id
            )
          },
          transaction
        );
        throw new Error("force milestone reconciliation rollback");
      })
    ).rejects.toThrow("force milestone reconciliation rollback");
    await expect(
      db.planningTask.findUniqueOrThrow({ where: { id: rollbackTask.task.taskId } })
    ).resolves.toMatchObject({ status: "NOT_STARTED", version: rollbackTask.resourceVersion });
    await expect(
      db.projectMilestone.findUniqueOrThrow({ where: { id: rollbackMilestone.milestone.id } })
    ).resolves.toMatchObject({ status: "PENDING", achievementSource: null });
    await expect(
      db.projectMilestoneEvent.count({
        where: {
          milestoneId: rollbackMilestone.milestone.id,
          eventType: "ACHIEVED_FROM_LINKED_TASKS"
        }
      })
    ).resolves.toBe(0);
    await expect(
      db.auditLog.count({
        where: {
          objectId: rollbackMilestone.milestone.id,
          action: "PROJECT_MILESTONE_ACHIEVED_FROM_LINKED_TASKS"
        }
      })
    ).resolves.toBe(0);
    await expect(
      db.outboxEvent.count({
        where: {
          eventType: "project.milestone.achieved-from-linked-tasks",
          aggregateId: rollbackMilestone.milestone.id
        }
      })
    ).resolves.toBe(0);
  });

  it("exposes only authorized project execution data with stable empty, stale, and failed states", async () => {
    const ready = await createReadyProject("EXECUTION-READ");
    const url = `http://localhost/api/projects/${ready.project.id}/execution`;

    expect(
      (
        await readExecutionRoute(readRequest(url, ids.outsider), {
          params: Promise.resolve({ projectId: ready.project.id })
        })
      ).status
    ).toBe(403);

    const emptyResponse = await readExecutionRoute(readRequest(url, ids.owner), {
      params: Promise.resolve({ projectId: ready.project.id })
    });
    expect(emptyResponse.status).toBe(200);
    await expect(emptyResponse.json()).resolves.toMatchObject({
      progress: { status: "EMPTY" },
      schedule: { status: "NOT_REQUESTED", stale: false },
      tasks: []
    });

    await saveProjectCalendar({
      projectId: ready.project.id,
      version: 0,
      name: "每工作日十小时",
      timeZone: "Asia/Shanghai",
      weeklyRules: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
        dayOfWeek,
        intervals: [{ startMinute: 480, endMinute: 1080 }]
      })),
      exceptions: [],
      reason: "配置执行页工日口径",
      actorId: ids.admin,
      auditContext: context(ids.admin, `execution-calendar-${suffix}`, ready.project.id)
    });
    const wbs = await createWbsNode({
      projectId: ready.project.id,
      ...wbsBody("EXECUTION-READ"),
      actorId: ids.admin,
      auditContext: context(ids.admin, `execution-wbs-${suffix}`, ready.project.id)
    });
    const created = await createPlanningTask({
      projectId: ready.project.id,
      ...taskBody(ready, wbs.wbsNode.nodeId),
      actorId: ids.admin,
      auditContext: context(ids.admin, `execution-task-${suffix}`, ready.project.id)
    });

    const staleResponse = await readExecutionRoute(readRequest(url, ids.owner), {
      params: Promise.resolve({ projectId: ready.project.id })
    });
    expect(staleResponse.status).toBe(200);
    const stalePayload = (await staleResponse.json()) as {
      progress: {
        status: string;
        completedWorkdays: number;
        totalWorkdays: number;
        percent: number;
      };
      schedule: { status: string; stale: boolean; error: unknown };
      tasks: Array<Record<string, unknown>>;
    };
    expect(stalePayload.progress).toEqual({
      status: "READY",
      completedWorkdays: 0,
      totalWorkdays: 4,
      percent: 0,
      calculatedAt: expect.any(String)
    });
    expect(stalePayload.schedule).toMatchObject({ status: "PENDING", stale: true, error: null });
    expect(stalePayload.tasks).toHaveLength(1);
    expect(stalePayload.tasks[0]).not.toHaveProperty("plannedDurationMinutes");
    expect(stalePayload.tasks[0]).toMatchObject({ taskId: created.task.taskId });

    const state = await db.projectScheduleState.findUniqueOrThrow({
      where: { projectId: ready.project.id }
    });
    await db.scheduleRecalculation.update({
      where: {
        projectId_inputVersion: { projectId: ready.project.id, inputVersion: state.inputVersion }
      },
      data: {
        status: "FAILED",
        errorCode: "EXECUTION_FORECAST_FAILED",
        errorMessage: "项目预测计算失败。",
        completedAt: new Date()
      }
    });

    const failedResponse = await readExecutionRoute(readRequest(url, ids.owner), {
      params: Promise.resolve({ projectId: ready.project.id })
    });
    expect(failedResponse.status).toBe(200);
    const failedPayload = (await failedResponse.json()) as {
      schedule: { status: string; stale: boolean; error: Record<string, unknown> | null };
    };
    expect(failedPayload.schedule).toMatchObject({
      status: "FAILED",
      stale: true,
      error: { code: "EXECUTION_FORECAST_FAILED", message: "项目预测计算失败。" }
    });
    expect(failedPayload.schedule.error).not.toHaveProperty("stack");

    await closePlanningTask({
      projectId: ready.project.id,
      taskId: created.task.taskId,
      version: created.resourceVersion,
      reason: "关闭后不再参与项目执行进度",
      actorId: ids.admin,
      auditContext: context(ids.admin, `execution-close-${suffix}`, ready.project.id)
    });
    const closedTaskResponse = await readExecutionRoute(readRequest(url, ids.owner), {
      params: Promise.resolve({ projectId: ready.project.id })
    });
    await expect(closedTaskResponse.json()).resolves.toMatchObject({
      progress: { status: "EMPTY" },
      tasks: [],
      responsibilityPackages: [{ effectiveTaskCount: 0 }]
    });
  });

  it("completes and closes tasks without creating dependency, baseline, or progress models", async () => {
    const ready = await createReadyProject("CLOSE");
    const wbs = await createWbsNode({
      projectId: ready.project.id,
      ...wbsBody("CLOSEOUT"),
      actorId: ids.admin,
      auditContext: context(ids.admin, `close-wbs-${suffix}`, ready.project.id)
    });
    const created = await createPlanningTask({
      projectId: ready.project.id,
      ...taskBody(ready, wbs.wbsNode.nodeId),
      actorId: ids.admin,
      auditContext: context(ids.admin, `close-task-${suffix}`, ready.project.id)
    });
    const taskId = created.task.taskId;
    const commandUrl = `http://localhost/api/projects/${ready.project.id}/tasks/${taskId}`;
    const completed = await commandTaskRoute(
      postRequest(
        commandUrl + "/progress",
        {
          version: 1,
          actualStartAt: "2026-08-04T00:00:00.000Z",
          actualFinishAt: "2026-08-09T00:00:00.000Z",
          remainingDurationMinutes: 0,
          forecastFinishAt: "2026-08-12T00:00:00.000Z",
          reason: "完成任务"
        },
        `complete-task-${suffix}`,
        ids.owner
      ),
      { params: Promise.resolve({ projectId: ready.project.id, taskId, command: "progress" }) }
    );
    expect(await completed.json()).toMatchObject({ task: { status: "COMPLETED" } });
    const { code: _code, ...plan } = taskBody(ready, wbs.wbsNode.nodeId);
    await expect(
      updatePlanningTask({
        projectId: ready.project.id,
        taskId,
        ...plan,
        version: 2,
        actorId: ids.admin,
        auditContext: context(ids.admin, `late-plan-${suffix}`, ready.project.id)
      })
    ).rejects.toMatchObject({ code: "TASK_PLAN_NOT_EDITABLE", status: 409 });
    expect(
      (
        await commandTaskRoute(
          postRequest(
            commandUrl + "/close",
            { version: 2, reason: "关闭任务" },
            `close-task-command-${suffix}`
          ),
          { params: Promise.resolve({ projectId: ready.project.id, taskId, command: "close" }) }
        )
      ).status
    ).toBe(200);
    const tables = await db.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'critical_paths', 'project_progress_projections'
      )
    `;
    expect(tables).toEqual([]);
  });

  it("rolls back failed writes and enforces hierarchy, relations, and soft removal in SQL", async () => {
    const ready = await createReadyProject("CONSTRAINT");
    const other = await createReadyProject("CONSTRAINT-OTHER");
    const root = await createWbsNode({
      projectId: ready.project.id,
      ...wbsBody("ROOT"),
      actorId: ids.admin,
      auditContext: context(ids.admin, `constraint-root-${suffix}`, ready.project.id)
    });
    const child = await createWbsNode({
      projectId: ready.project.id,
      ...wbsBody("ROOT.CHILD", root.wbsNode.nodeId),
      actorId: ids.admin,
      auditContext: context(ids.admin, `constraint-child-${suffix}`, ready.project.id)
    });
    await expect(
      db.wbsNode.update({
        where: { id: root.wbsNode.nodeId },
        data: { parentId: child.wbsNode.nodeId, version: { increment: 1 } }
      })
    ).rejects.toThrow(/cycle/u);
    await expect(
      db.planningTask.create({
        data: {
          projectId: ready.project.id,
          wbsNodeId: root.wbsNode.nodeId,
          ownerMembershipId: other.ownerMembership.id,
          code: `BAD.OWNER.${suffix}`.toUpperCase(),
          name: "跨项目负责人",
          position: 0,
          plannedStartAt: new Date("2026-08-03T00:00:00.000Z"),
          plannedFinishAt: new Date("2026-08-10T00:00:00.000Z"),
          plannedDurationMinutes: 2400,
          weight: 25,
          remainingDurationMinutes: 2400,
          forecastFinishAt: new Date("2026-08-10T00:00:00.000Z"),
          createdById: ids.admin,
          updatedById: ids.admin
        }
      })
    ).rejects.toThrow(/active member of the same project/u);
    await expect(db.wbsNode.delete({ where: { id: child.wbsNode.nodeId } })).rejects.toThrow(
      /closed instead of removed/u
    );
    await expect(
      db.$executeRawUnsafe('TRUNCATE TABLE "planning_tasks", "wbs_nodes", "task_dependencies"')
    ).rejects.toThrow(/closed instead of removed|cannot truncate a table referenced/u);

    await expect(
      createPlanningTask({
        projectId: ready.project.id,
        ...taskBody(ready, root.wbsNode.nodeId),
        code: "ROLLBACK.BAD.ACTOR",
        actorId: `missing-planning-actor-${suffix}`,
        auditContext: context(
          `missing-planning-actor-${suffix}`,
          `rollback-planning-${suffix}`,
          ready.project.id
        )
      })
    ).rejects.toMatchObject({ code: "PLANNING_RELATION_INVALID", status: 409 });
    await expect(
      db.planningTask.count({ where: { projectId: ready.project.id, code: "ROLLBACK.BAD.ACTOR" } })
    ).resolves.toBe(0);
    await expect(
      db.auditLog.count({
        where: {
          projectId: ready.project.id,
          action: "PLANNING_TASK_CREATED",
          objectId: { not: null }
        }
      })
    ).resolves.toBe(0);
  });
});
