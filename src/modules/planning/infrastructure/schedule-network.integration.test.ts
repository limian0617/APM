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

import { createPlanningTask, createWbsNode } from "../application/planning-service";
import { createTaskDependency, saveProjectCalendar } from "../application/schedule-network-service";
import {
  GET as readCalendarRoute,
  PUT as saveCalendarRoute
} from "../../../app/api/projects/[projectId]/planning-calendar/route";
import { POST as closeCalendarRoute } from "../../../app/api/projects/[projectId]/planning-calendar/close/route";
import {
  GET as listDependenciesRoute,
  POST as createDependencyRoute
} from "../../../app/api/projects/[projectId]/task-dependencies/route";
import { PUT as updateDependencyRoute } from "../../../app/api/projects/[projectId]/task-dependencies/[dependencyId]/route";
import { POST as closeDependencyRoute } from "../../../app/api/projects/[projectId]/task-dependencies/[dependencyId]/close/route";
import { POST as commandTaskRoute } from "../../../app/api/projects/[projectId]/tasks/[taskId]/[command]/route";

const databaseEnabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const describeDatabase = databaseEnabled ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `schedule-admin-${suffix}`,
  owner: `schedule-owner-${suffix}`,
  outsider: `schedule-outsider-${suffix}`
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
      const code = `SCHEDULE.${componentType}.${suffix}`.toUpperCase();
      const draft = await saveTemplateComponentDraft({
        code,
        componentType,
        name: `${componentType} schedule test`,
        content: componentDefinition(componentType),
        version: 0,
        reason: "创建计划网络测试组件",
        actorId: ids.admin,
        auditContext: context(ids.admin, `component-draft-${componentType}-${suffix}`)
      });
      return (
        await publishTemplateComponent({
          code,
          version: draft.component.version,
          reason: "发布计划网络测试组件",
          actorId: ids.admin,
          auditContext: context(ids.admin, `component-publish-${componentType}-${suffix}`)
        })
      ).publishedVersion;
    })
  );
  const code = `SCHEDULE.TEMPLATE.${suffix}`.toUpperCase();
  const draft = await saveProjectTemplateDraft({
    code,
    name: "计划网络测试模板",
    components: versions.map((version, position) => ({
      componentVersionId: version.id,
      componentType: version.componentType,
      slot: `${version.componentType}.${position}`,
      position
    })),
    version: 0,
    reason: "创建计划网络测试模板",
    actorId: ids.admin,
    auditContext: context(ids.admin, `template-draft-${suffix}`)
  });
  return {
    code,
    ...(await publishProjectTemplate({
      code,
      version: draft.template.version,
      reason: "发布计划网络测试模板",
      actorId: ids.admin,
      auditContext: context(ids.admin, `template-publish-${suffix}`)
    }))
  };
}

function request(
  method: "POST" | "PUT",
  url: string,
  body: unknown,
  key: string,
  actorId = ids.admin
) {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-apm-user-id": actorId,
      "idempotency-key": key,
      "x-request-id": `request-${key}`
    },
    body: JSON.stringify(body)
  });
}

function readRequest(url: string, actorId = ids.admin) {
  return new Request(url, { headers: { "x-apm-user-id": actorId } });
}

function calendarBody(version: number, name = "项目标准工作日历") {
  return {
    version,
    name,
    timeZone: "Asia/Shanghai",
    weeklyRules: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      dayOfWeek,
      intervals: [
        { startMinute: 480, endMinute: 720 },
        { startMinute: 780, endMinute: 1020 }
      ]
    })),
    exceptions: [{ date: "2026-10-01", intervals: [] }],
    reason: "维护项目工作日历"
  };
}

describeDatabase("APM-021 PostgreSQL calendars and dependency graph", () => {
  let template: Awaited<ReturnType<typeof seedPublishedTemplate>>;
  let projectSequence = 0;

  async function createReadyProject(label: string) {
    projectSequence += 1;
    const project = (
      await createProjectFromTemplate({
        code: `P21.${label}.${projectSequence}.${suffix}`.toUpperCase(),
        name: `${label} schedule project`,
        departmentId: "engineering",
        templateCode: template.code,
        templateVersion: template.publishedVersion.version,
        templateChecksum: template.publishedVersion.checksum,
        reason: "创建计划网络测试项目",
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
      reason: "初始化计划网络测试结构",
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
      reason: "创建计划网络WBS",
      actorId: ids.admin,
      auditContext: context(ids.admin, `wbs-${label}-${projectSequence}-${suffix}`, project.id)
    });
    const tasks = [];
    for (const [position, code] of ["TASK.A", "TASK.B", "TASK.C", "TASK.D"].entries()) {
      tasks.push(
        (
          await createPlanningTask({
            projectId: project.id,
            code,
            name: `${code} 计划任务`,
            wbsNodeId: wbs.wbsNode.nodeId,
            ownerMembershipId: ownerMembership.id,
            position,
            plannedStartAt: new Date(
              `2026-08-${String(4 + position).padStart(2, "0")}T00:00:00.000Z`
            ),
            plannedFinishAt: new Date(
              `2026-08-${String(5 + position).padStart(2, "0")}T00:00:00.000Z`
            ),
            plannedDurationMinutes: 480,
            weight: 10,
            reason: "创建计划网络任务",
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
    return { project, tasks };
  }

  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `SCHEDULE-ADMIN-${suffix}`,
          name: "计划网络管理员",
          departmentId: "engineering"
        },
        {
          id: ids.owner,
          employeeNo: `SCHEDULE-OWNER-${suffix}`,
          name: "计划任务负责人",
          departmentId: "engineering"
        },
        {
          id: ids.outsider,
          employeeNo: `SCHEDULE-OUTSIDER-${suffix}`,
          name: "非项目成员",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `schedule-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        { id: `schedule-role-owner-${suffix}`, userId: ids.owner, roleId: "role-engineer" },
        { id: `schedule-role-outsider-${suffix}`, userId: ids.outsider, roleId: "role-engineer" }
      ]
    });
    template = await seedPublishedTemplate();
  });

  it("creates, replays, versions, reads, and closes a project work calendar", async () => {
    const ready = await createReadyProject("CALENDAR");
    const url = `http://localhost/api/projects/${ready.project.id}/planning-calendar`;
    const first = await saveCalendarRoute(
      request("PUT", url, calendarBody(0), `calendar-create-${suffix}`),
      { params: Promise.resolve({ projectId: ready.project.id }) }
    );
    const firstBody = (await first.json()) as {
      calendar: { calendarId: string; resourceVersion: number };
    };
    const replay = await saveCalendarRoute(
      request("PUT", url, calendarBody(0), `calendar-create-${suffix}`),
      { params: Promise.resolve({ projectId: ready.project.id }) }
    );
    expect(first.status).toBe(200);
    expect(firstBody.calendar.resourceVersion).toBe(1);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(
      (
        await readCalendarRoute(readRequest(url, ids.outsider), {
          params: Promise.resolve({ projectId: ready.project.id })
        })
      ).status
    ).toBe(403);

    const updates = await Promise.all([
      saveCalendarRoute(
        request("PUT", url, calendarBody(1, "项目工作日历 A"), `calendar-update-a-${suffix}`),
        { params: Promise.resolve({ projectId: ready.project.id }) }
      ),
      saveCalendarRoute(
        request("PUT", url, calendarBody(1, "项目工作日历 B"), `calendar-update-b-${suffix}`),
        { params: Promise.resolve({ projectId: ready.project.id }) }
      )
    ]);
    expect(updates.map(({ status }) => status).sort()).toEqual([200, 409]);
    const current = await readCalendarRoute(readRequest(url), {
      params: Promise.resolve({ projectId: ready.project.id })
    });
    expect(await current.json()).toMatchObject({ calendar: { resourceVersion: 2, revision: 2 } });
    const closed = await closeCalendarRoute(
      request(
        "POST",
        `${url}/close`,
        { version: 2, reason: "关闭项目日历" },
        `calendar-close-${suffix}`
      ),
      { params: Promise.resolve({ projectId: ready.project.id }) }
    );
    expect(await closed.json()).toMatchObject({
      calendar: { status: "CLOSED", resourceVersion: 3 }
    });
    await expect(
      db.projectCalendarRevision.update({
        where: {
          id: (
            await db.projectCalendarRevision.findFirstOrThrow({
              where: { calendarId: firstBody.calendar.calendarId }
            })
          ).id
        },
        data: { name: "不得改写" }
      })
    ).rejects.toThrow(/append-only/u);
  });

  it("stores FS, SS, and FF dependencies with lag and rejects IDOR", async () => {
    const ready = await createReadyProject("TYPES");
    const other = await createReadyProject("TYPES-OTHER");
    const url = `http://localhost/api/projects/${ready.project.id}/task-dependencies`;
    const definitions = [
      {
        predecessorTaskId: ready.tasks[0]!.taskId,
        successorTaskId: ready.tasks[1]!.taskId,
        dependencyType: "FS",
        lagMinutes: 0
      },
      {
        predecessorTaskId: ready.tasks[1]!.taskId,
        successorTaskId: ready.tasks[2]!.taskId,
        dependencyType: "SS",
        lagMinutes: -480
      },
      {
        predecessorTaskId: ready.tasks[2]!.taskId,
        successorTaskId: ready.tasks[3]!.taskId,
        dependencyType: "FF",
        lagMinutes: 60
      }
    ] as const;
    for (const [index, definition] of definitions.entries()) {
      const body = { ...definition, reason: "创建任务依赖" };
      const key = `dependency-type-${index}-${suffix}`;
      const response = await createDependencyRoute(request("POST", url, body, key), {
        params: Promise.resolve({ projectId: ready.project.id })
      });
      expect(response.status).toBe(201);
      if (index === 0) {
        const replay = await createDependencyRoute(request("POST", url, body, key), {
          params: Promise.resolve({ projectId: ready.project.id })
        });
        expect(replay.headers.get("idempotency-replayed")).toBe("true");
      }
    }
    const list = await listDependenciesRoute(readRequest(url), {
      params: Promise.resolve({ projectId: ready.project.id })
    });
    const listBody = (await list.json()) as {
      dependencies: Array<{ dependencyType: string; lagMinutes: number }>;
    };
    expect(listBody.dependencies.map(({ dependencyType }) => dependencyType).sort()).toEqual([
      "FF",
      "FS",
      "SS"
    ]);
    expect(
      listBody.dependencies.find(({ dependencyType }) => dependencyType === "SS")?.lagMinutes
    ).toBe(-480);
    expect(
      (
        await createDependencyRoute(
          request(
            "POST",
            url,
            { ...definitions[0], reason: "越权创建" },
            `dependency-outsider-${suffix}`,
            ids.outsider
          ),
          { params: Promise.resolve({ projectId: ready.project.id }) }
        )
      ).status
    ).toBe(403);
    await expect(
      createTaskDependency({
        projectId: ready.project.id,
        predecessorTaskId: ready.tasks[0]!.taskId,
        successorTaskId: other.tasks[0]!.taskId,
        dependencyType: "FS",
        lagMinutes: 0,
        reason: "跨项目依赖",
        actorId: ids.admin,
        auditContext: context(ids.admin, `cross-project-${suffix}`, ready.project.id)
      })
    ).rejects.toMatchObject({ code: "TASK_DEPENDENCY_RELATION_INVALID", status: 409 });
  });

  it("rejects transitive and concurrent dependency cycles", async () => {
    const ready = await createReadyProject("CYCLE");
    const url = `http://localhost/api/projects/${ready.project.id}/task-dependencies`;
    for (const [index, pair] of [
      [ready.tasks[0]!, ready.tasks[1]!],
      [ready.tasks[1]!, ready.tasks[2]!]
    ].entries()) {
      expect(
        (
          await createDependencyRoute(
            request(
              "POST",
              url,
              {
                predecessorTaskId: pair[0].taskId,
                successorTaskId: pair[1].taskId,
                dependencyType: "FS",
                lagMinutes: 0,
                reason: "建立有向边"
              },
              `cycle-edge-${index}-${suffix}`
            ),
            { params: Promise.resolve({ projectId: ready.project.id }) }
          )
        ).status
      ).toBe(201);
    }
    expect(
      (
        await createDependencyRoute(
          request(
            "POST",
            url,
            {
              predecessorTaskId: ready.tasks[2]!.taskId,
              successorTaskId: ready.tasks[0]!.taskId,
              dependencyType: "FS",
              lagMinutes: 0,
              reason: "尝试形成环"
            },
            `cycle-reject-${suffix}`
          ),
          { params: Promise.resolve({ projectId: ready.project.id }) }
        )
      ).status
    ).toBe(409);

    const concurrent = await createReadyProject("CONCURRENT-CYCLE");
    const concurrentUrl = `http://localhost/api/projects/${concurrent.project.id}/task-dependencies`;
    const outcomes = await Promise.all([
      createDependencyRoute(
        request(
          "POST",
          concurrentUrl,
          {
            predecessorTaskId: concurrent.tasks[0]!.taskId,
            successorTaskId: concurrent.tasks[1]!.taskId,
            dependencyType: "FS",
            lagMinutes: 0,
            reason: "并发边A"
          },
          `concurrent-cycle-a-${suffix}`
        ),
        { params: Promise.resolve({ projectId: concurrent.project.id }) }
      ),
      createDependencyRoute(
        request(
          "POST",
          concurrentUrl,
          {
            predecessorTaskId: concurrent.tasks[1]!.taskId,
            successorTaskId: concurrent.tasks[0]!.taskId,
            dependencyType: "FS",
            lagMinutes: 0,
            reason: "并发边B"
          },
          `concurrent-cycle-b-${suffix}`
        ),
        { params: Promise.resolve({ projectId: concurrent.project.id }) }
      )
    ]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual([201, 409]);
  });

  it("updates and closes dependencies before allowing a related task to close", async () => {
    const ready = await createReadyProject("CLOSE");
    const url = `http://localhost/api/projects/${ready.project.id}/task-dependencies`;
    const created = await createDependencyRoute(
      request(
        "POST",
        url,
        {
          predecessorTaskId: ready.tasks[0]!.taskId,
          successorTaskId: ready.tasks[1]!.taskId,
          dependencyType: "FS",
          lagMinutes: 0,
          reason: "创建待维护依赖"
        },
        `dependency-close-create-${suffix}`
      ),
      { params: Promise.resolve({ projectId: ready.project.id }) }
    );
    const createdBody = (await created.json()) as { dependency: { dependencyId: string } };
    const dependencyUrl = `${url}/${createdBody.dependency.dependencyId}`;
    const updated = await updateDependencyRoute(
      request(
        "PUT",
        dependencyUrl,
        { version: 1, dependencyType: "FF", lagMinutes: -60, reason: "调整依赖" },
        `dependency-update-${suffix}`
      ),
      {
        params: Promise.resolve({
          projectId: ready.project.id,
          dependencyId: createdBody.dependency.dependencyId
        })
      }
    );
    expect(await updated.json()).toMatchObject({
      dependency: { dependencyType: "FF", resourceVersion: 2 }
    });
    const taskUrl = `http://localhost/api/projects/${ready.project.id}/tasks/${ready.tasks[0]!.taskId}/close`;
    expect(
      (
        await commandTaskRoute(
          request(
            "POST",
            taskUrl,
            { version: 1, reason: "关闭有依赖任务" },
            `task-close-blocked-${suffix}`
          ),
          {
            params: Promise.resolve({
              projectId: ready.project.id,
              taskId: ready.tasks[0]!.taskId,
              command: "close"
            })
          }
        )
      ).status
    ).toBe(409);
    expect(
      (
        await closeDependencyRoute(
          request(
            "POST",
            `${dependencyUrl}/close`,
            { version: 2, reason: "关闭依赖" },
            `dependency-close-${suffix}`
          ),
          {
            params: Promise.resolve({
              projectId: ready.project.id,
              dependencyId: createdBody.dependency.dependencyId
            })
          }
        )
      ).status
    ).toBe(200);
    expect(
      (
        await commandTaskRoute(
          request(
            "POST",
            taskUrl,
            { version: 1, reason: "关闭无依赖任务" },
            `task-close-allowed-${suffix}`
          ),
          {
            params: Promise.resolve({
              projectId: ready.project.id,
              taskId: ready.tasks[0]!.taskId,
              command: "close"
            })
          }
        )
      ).status
    ).toBe(200);
    await expect(
      db.taskDependency.delete({ where: { id: createdBody.dependency.dependencyId } })
    ).rejects.toThrow(/closed instead of removed/u);
  });

  it("serializes concurrent task closure and dependency creation", async () => {
    const ready = await createReadyProject("CONCURRENT-CLOSE");
    const dependencyUrl = `http://localhost/api/projects/${ready.project.id}/task-dependencies`;
    const taskUrl = `http://localhost/api/projects/${ready.project.id}/tasks/${ready.tasks[0]!.taskId}/close`;
    const [dependencyResponse, closeResponse] = await Promise.all([
      createDependencyRoute(
        request(
          "POST",
          dependencyUrl,
          {
            predecessorTaskId: ready.tasks[0]!.taskId,
            successorTaskId: ready.tasks[1]!.taskId,
            dependencyType: "FS",
            lagMinutes: 0,
            reason: "并发创建任务依赖"
          },
          `concurrent-close-dependency-${suffix}`
        ),
        { params: Promise.resolve({ projectId: ready.project.id }) }
      ),
      commandTaskRoute(
        request(
          "POST",
          taskUrl,
          { version: 1, reason: "并发关闭任务" },
          `concurrent-close-task-${suffix}`
        ),
        {
          params: Promise.resolve({
            projectId: ready.project.id,
            taskId: ready.tasks[0]!.taskId,
            command: "close"
          })
        }
      )
    ]);

    expect([dependencyResponse.status, closeResponse.status]).toContain(409);
    expect(
      [dependencyResponse.status, closeResponse.status].filter((status) => status < 300)
    ).toHaveLength(1);

    const [task, activeDependencyCount] = await Promise.all([
      db.planningTask.findUniqueOrThrow({ where: { id: ready.tasks[0]!.taskId } }),
      db.taskDependency.count({
        where: {
          projectId: ready.project.id,
          status: "ACTIVE",
          OR: [
            { predecessorTaskId: ready.tasks[0]!.taskId },
            { successorTaskId: ready.tasks[0]!.taskId }
          ]
        }
      })
    ]);
    expect(task.status === "CLOSED" && activeDependencyCount > 0).toBe(false);
  });

  it("enforces calendar and graph constraints in SQL without future-package models", async () => {
    const ready = await createReadyProject("CONSTRAINT");
    const calendar = await saveProjectCalendar({
      projectId: ready.project.id,
      ...calendarBody(0),
      actorId: ids.admin,
      auditContext: context(ids.admin, `constraint-calendar-${suffix}`, ready.project.id)
    });
    await expect(
      db.$transaction(async (transaction) => {
        await transaction.projectCalendar.update({
          where: { id: calendar.calendar.calendarId },
          data: { version: { increment: 1 }, updatedById: ids.admin }
        });
        await transaction.projectCalendarRevision.create({
          data: {
            calendarId: calendar.calendar.calendarId,
            projectId: ready.project.id,
            revision: 2,
            name: "非法重叠日历",
            timeZone: "Asia/Shanghai",
            weeklyRules: [
              {
                dayOfWeek: 1,
                intervals: [
                  { startMinute: 480, endMinute: 720 },
                  { startMinute: 600, endMinute: 900 }
                ]
              }
            ],
            exceptions: [],
            checksum: "a".repeat(64),
            reason: "数据库应拒绝",
            createdById: ids.admin
          }
        });
      })
    ).rejects.toThrow(/weekly rule is invalid/u);
    await createTaskDependency({
      projectId: ready.project.id,
      predecessorTaskId: ready.tasks[0]!.taskId,
      successorTaskId: ready.tasks[1]!.taskId,
      dependencyType: "FS",
      lagMinutes: 0,
      reason: "创建数据库约束边",
      actorId: ids.admin,
      auditContext: context(ids.admin, `constraint-edge-a-${suffix}`, ready.project.id)
    });
    await createTaskDependency({
      projectId: ready.project.id,
      predecessorTaskId: ready.tasks[1]!.taskId,
      successorTaskId: ready.tasks[2]!.taskId,
      dependencyType: "FS",
      lagMinutes: 0,
      reason: "创建数据库约束边",
      actorId: ids.admin,
      auditContext: context(ids.admin, `constraint-edge-b-${suffix}`, ready.project.id)
    });
    await expect(
      db.taskDependency.create({
        data: {
          projectId: ready.project.id,
          predecessorTaskId: ready.tasks[2]!.taskId,
          successorTaskId: ready.tasks[0]!.taskId,
          dependencyType: "FS",
          lagMinutes: 0,
          createdById: ids.admin,
          updatedById: ids.admin
        }
      })
    ).rejects.toThrow(/cannot contain a cycle/u);
    await expect(db.$executeRawUnsafe('TRUNCATE TABLE "task_dependencies"')).rejects.toThrow(
      /closed instead of removed/u
    );
    const futureTables = await db.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'planning_recalculations', 'critical_path_results', 'plan_baselines', 'project_progress_projections'
      )
    `;
    expect(futureTables).toEqual([]);
  });

  it("rolls back dependency, audit, and Outbox facts on failure", async () => {
    const ready = await createReadyProject("ROLLBACK");
    const before = await db.auditLog.count({
      where: { projectId: ready.project.id, action: "TASK_DEPENDENCY_CREATED" }
    });
    const outboxBefore = await db.outboxEvent.count({
      where: { eventType: "planning.task-dependency.created" }
    });
    await expect(
      createTaskDependency({
        projectId: ready.project.id,
        predecessorTaskId: ready.tasks[0]!.taskId,
        successorTaskId: ready.tasks[1]!.taskId,
        dependencyType: "FS",
        lagMinutes: 0,
        reason: "缺失actor应回滚",
        actorId: `missing-schedule-actor-${suffix}`,
        auditContext: context(
          `missing-schedule-actor-${suffix}`,
          `rollback-dependency-${suffix}`,
          ready.project.id
        )
      })
    ).rejects.toMatchObject({ code: "SCHEDULE_RELATION_INVALID", status: 409 });
    await expect(
      db.taskDependency.count({
        where: {
          projectId: ready.project.id,
          predecessorTaskId: ready.tasks[0]!.taskId,
          successorTaskId: ready.tasks[1]!.taskId
        }
      })
    ).resolves.toBe(0);
    await expect(
      db.auditLog.count({
        where: { projectId: ready.project.id, action: "TASK_DEPENDENCY_CREATED" }
      })
    ).resolves.toBe(before);
    await expect(
      db.outboxEvent.count({
        where: { eventType: "planning.task-dependency.created" }
      })
    ).resolves.toBe(outboxBefore);
  });
});
