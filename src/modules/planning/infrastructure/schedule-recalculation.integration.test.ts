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
import type { JobExecution } from "@/modules/governance/contracts/jobs";
import { createProjectFromTemplate } from "@/modules/projects/application/create-project";
import { initializeProjectStructure } from "@/modules/projects/application/project-structure";
import { createPlanningJobHandlers } from "@/workers/planning-job-handlers";

import {
  createPlanningTask,
  createWbsNode,
  updatePlanningTaskProgress
} from "../application/planning-service";
import { createTaskDependency, saveProjectCalendar } from "../application/schedule-network-service";
import { GET as readScheduleForecastRoute } from "../../../app/api/projects/[projectId]/schedule-forecast/route";

const databaseEnabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const describeDatabase = databaseEnabled ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `forecast-admin-${suffix}`,
  owner: `forecast-owner-${suffix}`,
  outsider: `forecast-outsider-${suffix}`
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
      return { packages: [{ code: "S0.PLAN", name: "计划", stageCode: "S0", weight: 10 }] };
  }
}

async function seedPublishedTemplate() {
  const versions = await Promise.all(
    (["STAGE", "GATE", "ROLE", "WBS"] as const).map(async (componentType) => {
      const code = `FORECAST.${componentType}.${suffix}`.toUpperCase();
      const draft = await saveTemplateComponentDraft({
        code,
        componentType,
        name: `${componentType} forecast test`,
        content: componentDefinition(componentType),
        version: 0,
        reason: "创建预测测试组件",
        actorId: ids.admin,
        auditContext: context(ids.admin, `component-draft-${componentType}-${suffix}`)
      });
      return (
        await publishTemplateComponent({
          code,
          version: draft.component.version,
          reason: "发布预测测试组件",
          actorId: ids.admin,
          auditContext: context(ids.admin, `component-publish-${componentType}-${suffix}`)
        })
      ).publishedVersion;
    })
  );
  const code = `FORECAST.TEMPLATE.${suffix}`.toUpperCase();
  const draft = await saveProjectTemplateDraft({
    code,
    name: "计划预测测试模板",
    components: versions.map((version, position) => ({
      componentVersionId: version.id,
      componentType: version.componentType,
      slot: `${version.componentType}.${position}`,
      position
    })),
    version: 0,
    reason: "创建计划预测测试模板",
    actorId: ids.admin,
    auditContext: context(ids.admin, `template-draft-${suffix}`)
  });
  return {
    code,
    ...(await publishProjectTemplate({
      code,
      version: draft.template.version,
      reason: "发布计划预测测试模板",
      actorId: ids.admin,
      auditContext: context(ids.admin, `template-publish-${suffix}`)
    }))
  };
}

function calendarBody(version: number) {
  return {
    version,
    name: "项目标准工作日历",
    timeZone: "Asia/Shanghai",
    weeklyRules: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      dayOfWeek,
      intervals: [
        { startMinute: 480, endMinute: 720 },
        { startMinute: 780, endMinute: 1020 }
      ]
    })),
    exceptions: [{ date: "2026-10-01", intervals: [] }],
    reason: "配置预测测试日历"
  };
}

function readRequest(url: string, actorId = ids.admin) {
  return new Request(url, { headers: { "x-apm-user-id": actorId } });
}

function job(recalculation: {
  id: string;
  projectId: string;
  inputVersion: number;
  algorithmVersion: string;
}): JobExecution {
  return {
    id: `job-${recalculation.id}`,
    jobType: "planning.schedule-recalculation.requested",
    payload: {
      recalculationId: recalculation.id,
      projectId: recalculation.projectId,
      inputVersion: recalculation.inputVersion,
      algorithmVersion: recalculation.algorithmVersion
    },
    payloadHash: "a".repeat(64),
    idempotencyKey: `${recalculation.projectId}:v${recalculation.inputVersion}`,
    traceId: "a".repeat(32),
    attemptId: `attempt-${recalculation.id}`,
    attemptNumber: 1,
    maxAttempts: 3,
    isReplay: false,
    workerId: `forecast-worker-${suffix}`
  };
}

describeDatabase("APM-022 PostgreSQL schedule recalculation", () => {
  let template: Awaited<ReturnType<typeof seedPublishedTemplate>>;
  let projectSequence = 0;
  const handler = createPlanningJobHandlers()["planning.schedule-recalculation.requested"]!;

  async function createReadyProject(
    label: string,
    options: { includeCalendar?: boolean; taskCount?: number } = {}
  ) {
    const { includeCalendar = true, taskCount = 4 } = options;
    projectSequence += 1;
    const project = (
      await createProjectFromTemplate({
        code: `P22.${label}.${projectSequence}.${suffix}`.toUpperCase(),
        name: `${label} forecast project`,
        departmentId: "engineering",
        templateCode: template.code,
        templateVersion: template.publishedVersion.version,
        templateChecksum: template.publishedVersion.checksum,
        reason: "创建计划预测测试项目",
        actorId: ids.admin,
        auditContext: context(ids.admin, `project-${label}-${projectSequence}-${suffix}`)
      })
    ).project;
    await initializeProjectStructure({
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
      modules: [],
      reason: "初始化预测测试结构",
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
    const wbs = await createWbsNode({
      projectId: project.id,
      code: "EXECUTION",
      name: "执行计划",
      parentId: null,
      position: 0,
      reason: "创建预测测试WBS",
      actorId: ids.admin,
      auditContext: context(ids.admin, `wbs-${label}-${projectSequence}-${suffix}`, project.id)
    });
    if (includeCalendar) {
      await saveProjectCalendar({
        projectId: project.id,
        ...calendarBody(0),
        actorId: ids.admin,
        auditContext: context(
          ids.admin,
          `calendar-${label}-${projectSequence}-${suffix}`,
          project.id
        )
      });
    }
    const tasks = [];
    for (const [position, code] of ["TASK.A", "TASK.B", "TASK.C", "TASK.D"]
      .slice(0, taskCount)
      .entries()) {
      tasks.push(
        (
          await createPlanningTask({
            projectId: project.id,
            code,
            name: `${code} 预测任务`,
            wbsNodeId: wbs.wbsNode.nodeId,
            ownerMembershipId: ownerMembership.id,
            position,
            plannedStartAt: new Date("2026-08-03T00:00:00.000Z"),
            plannedFinishAt: new Date("2026-08-10T00:00:00.000Z"),
            plannedDurationMinutes: position === 2 ? 240 : 480,
            weight: 10,
            reason: "创建预测测试任务",
            actorId: ids.admin,
            auditContext: context(
              ids.admin,
              `task-${label}-${position}-${projectSequence}-${suffix}`,
              project.id
            )
          })
        ).task
      );
    }
    return { project, ownerMembership, tasks };
  }

  async function processProject(projectId: string) {
    const recalculations = await db.scheduleRecalculation.findMany({
      where: { projectId },
      orderBy: { inputVersion: "asc" }
    });
    for (const recalculation of recalculations) await handler(job(recalculation));
    return recalculations;
  }

  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `FORECAST-ADMIN-${suffix}`,
          name: "计划预测管理员",
          departmentId: "engineering"
        },
        {
          id: ids.owner,
          employeeNo: `FORECAST-OWNER-${suffix}`,
          name: "计划任务负责人",
          departmentId: "engineering"
        },
        {
          id: ids.outsider,
          employeeNo: `FORECAST-OUTSIDER-${suffix}`,
          name: "非项目成员",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `forecast-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        { id: `forecast-role-owner-${suffix}`, userId: ids.owner, roleId: "role-engineer" },
        { id: `forecast-role-outsider-${suffix}`, userId: ids.outsider, roleId: "role-engineer" }
      ]
    });
    template = await seedPublishedTemplate();
  });

  it("versions every schedule input and publishes only the latest asynchronous CPM result", async () => {
    const ready = await createReadyProject("CURRENT");
    for (const [index, definition] of [
      [ready.tasks[0]!, ready.tasks[1]!],
      [ready.tasks[0]!, ready.tasks[2]!],
      [ready.tasks[1]!, ready.tasks[3]!],
      [ready.tasks[2]!, ready.tasks[3]!]
    ].entries()) {
      await createTaskDependency({
        projectId: ready.project.id,
        predecessorTaskId: definition[0].taskId,
        successorTaskId: definition[1].taskId,
        dependencyType: "FS",
        lagMinutes: 0,
        reason: "创建预测网络依赖",
        actorId: ids.admin,
        auditContext: context(ids.admin, `dependency-${index}-${suffix}`, ready.project.id)
      });
    }
    const before = await db.projectScheduleState.findUniqueOrThrow({
      where: { projectId: ready.project.id }
    });
    expect(before.inputVersion).toBe(9);
    expect(
      await db.outboxEvent.count({
        where: {
          eventType: "planning.schedule-recalculation.requested",
          aggregateId: {
            in: (
              await db.scheduleRecalculation.findMany({
                where: { projectId: ready.project.id },
                select: { id: true }
              })
            ).map(({ id }) => id)
          }
        }
      })
    ).toBe(9);

    const recalculations = await processProject(ready.project.id);
    const stored = await db.scheduleRecalculation.findMany({
      where: { projectId: ready.project.id },
      orderBy: { inputVersion: "asc" }
    });
    expect(stored.slice(0, -1).every(({ status }) => status === "SUPERSEDED")).toBe(true);
    expect(stored.at(-1)).toMatchObject({
      id: recalculations.at(-1)!.id,
      status: "SUCCEEDED",
      inputChecksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
      resultChecksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
      taskCount: 4,
      dependencyCount: 4
    });
    const state = await db.projectScheduleState.findUniqueOrThrow({
      where: { projectId: ready.project.id }
    });
    expect(state.latestPublishedInputVersion).toBe(state.inputVersion);
    expect(await db.scheduleTaskForecast.count({ where: { projectId: ready.project.id } })).toBe(4);
    expect(
      await db.scheduleTaskForecast.count({
        where: { projectId: ready.project.id, isCritical: true }
      })
    ).toBe(3);

    const url = `http://localhost/api/projects/${ready.project.id}/schedule-forecast`;
    expect(
      (
        await readScheduleForecastRoute(readRequest(url, ids.outsider), {
          params: Promise.resolve({ projectId: ready.project.id })
        })
      ).status
    ).toBe(403);
    const response = await readScheduleForecastRoute(readRequest(url), {
      params: Promise.resolve({ projectId: ready.project.id })
    });
    expect(await response.json()).toMatchObject({
      schedule: {
        status: "SUCCEEDED",
        inputVersion: 9,
        publishedInputVersion: 9,
        stale: false,
        algorithmVersion: "cpm.v1",
        tasks: expect.any(Array)
      }
    });
  });

  it("keeps the last published result stale until a newer input version succeeds", async () => {
    const ready = await createReadyProject("STALE");
    await processProject(ready.project.id);
    const current = await db.planningTask.findUniqueOrThrow({
      where: { id: ready.tasks[0]!.taskId }
    });
    await updatePlanningTaskProgress({
      projectId: ready.project.id,
      taskId: current.id,
      version: current.version,
      actualStartAt: new Date("2026-08-03T00:00:00.000Z"),
      actualFinishAt: null,
      remainingDurationMinutes: 120,
      forecastFinishAt: new Date("2026-08-04T09:00:00.000Z"),
      reason: "更新当前预测输入",
      actorId: ids.admin,
      auditContext: context(ids.admin, `stale-input-${suffix}`, ready.project.id)
    });
    const url = `http://localhost/api/projects/${ready.project.id}/schedule-forecast`;
    const stale = await readScheduleForecastRoute(readRequest(url), {
      params: Promise.resolve({ projectId: ready.project.id })
    });
    expect(await stale.json()).toMatchObject({
      schedule: { status: "PENDING", stale: true, tasks: expect.any(Array) }
    });
    await processProject(ready.project.id);
    const currentResponse = await readScheduleForecastRoute(readRequest(url), {
      params: Promise.resolve({ projectId: ready.project.id })
    });
    expect(await currentResponse.json()).toMatchObject({
      schedule: { status: "SUCCEEDED", stale: false }
    });
  });

  it("stores a stable failure when the current input has no active calendar", async () => {
    const ready = await createReadyProject("NO-CALENDAR", { includeCalendar: false });
    await processProject(ready.project.id);
    const latest = await db.scheduleRecalculation.findFirstOrThrow({
      where: { projectId: ready.project.id },
      orderBy: { inputVersion: "desc" }
    });
    expect(latest).toMatchObject({
      status: "FAILED",
      errorCode: "ACTIVE_CALENDAR_REQUIRED",
      resultChecksum: null
    });
    expect(await db.scheduleTaskForecast.count({ where: { projectId: ready.project.id } })).toBe(0);
    const response = await readScheduleForecastRoute(
      readRequest(`http://localhost/api/projects/${ready.project.id}/schedule-forecast`),
      { params: Promise.resolve({ projectId: ready.project.id }) }
    );
    expect(await response.json()).toMatchObject({
      schedule: {
        status: "FAILED",
        stale: false,
        error: { code: "ACTIVE_CALENDAR_REQUIRED" },
        tasks: []
      }
    });
  });

  it("returns not-requested and empty successful results with stable API states", async () => {
    const notRequested = await createReadyProject("NOT-REQUESTED", {
      includeCalendar: false,
      taskCount: 0
    });
    const notRequestedResponse = await readScheduleForecastRoute(
      readRequest(`http://localhost/api/projects/${notRequested.project.id}/schedule-forecast`),
      { params: Promise.resolve({ projectId: notRequested.project.id }) }
    );
    expect(await notRequestedResponse.json()).toMatchObject({
      schedule: { status: "NOT_REQUESTED", stale: false, tasks: [] }
    });

    const empty = await createReadyProject("EMPTY", { taskCount: 0 });
    await processProject(empty.project.id);
    const emptyResponse = await readScheduleForecastRoute(
      readRequest(`http://localhost/api/projects/${empty.project.id}/schedule-forecast`),
      { params: Promise.resolve({ projectId: empty.project.id }) }
    );
    expect(await emptyResponse.json()).toMatchObject({
      schedule: {
        status: "SUCCEEDED",
        stale: false,
        projectFinishAt: null,
        tasks: []
      }
    });
  });

  it("enforces immutable forecast facts and same-project successful publication", async () => {
    const ready = await createReadyProject("IMMUTABLE");
    await processProject(ready.project.id);
    const forecast = await db.scheduleTaskForecast.findFirstOrThrow({
      where: { projectId: ready.project.id }
    });
    await expect(
      db.scheduleTaskForecast.update({
        where: { id: forecast.id },
        data: { totalFloatMinutes: forecast.totalFloatMinutes + 1 }
      })
    ).rejects.toThrow(/append-only/u);
    const state = await db.projectScheduleState.findUniqueOrThrow({
      where: { projectId: ready.project.id }
    });
    await expect(
      db.$transaction(async (client) => {
        const failed = await client.scheduleRecalculation.create({
          data: {
            projectId: ready.project.id,
            inputVersion: state.inputVersion + 1,
            algorithmVersion: "cpm.v1",
            sourceAction: "invalid.publication",
            reason: "数据库应拒绝失败结果发布",
            requestedById: ids.admin
          }
        });
        await client.projectScheduleState.update({
          where: { projectId: ready.project.id },
          data: { inputVersion: { increment: 1 } }
        });
        await client.projectScheduleState.update({
          where: { projectId: ready.project.id },
          data: {
            latestPublishedInputVersion: state.inputVersion + 1,
            latestPublishedRecalculationId: failed.id
          }
        });
      })
    ).rejects.toThrow(/successful version/u);
    await expect(
      db.$executeRawUnsafe(
        'TRUNCATE TABLE "schedule_task_forecasts", "schedule_recalculations", "project_schedule_states" CASCADE'
      )
    ).rejects.toThrow(/append-only/u);
  });

  it("does not create baseline, formal change, or progress projection tables", async () => {
    const futureTables = await db.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'plan_baselines', 'plan_changes', 'project_progress_projections'
      )
    `;
    expect(futureTables).toEqual([]);
  });
});
