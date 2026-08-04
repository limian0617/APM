import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";

import {
  GET as listPlanningBaselinesRoute,
  POST as freezePlanningBaselineRoute
} from "@/app/api/projects/[projectId]/planning-baselines/route";
import { GET as readPlanningBaselineRoute } from "@/app/api/projects/[projectId]/planning-baselines/[baselineId]/route";
import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  publishProjectTemplate,
  publishTemplateComponent,
  saveProjectTemplateDraft,
  saveTemplateComponentDraft
} from "@/modules/configuration/application/template-service";
import { createGateInstance, runGateChecks } from "@/modules/governance/application/gate-service";
import {
  decideGateSubmission,
  submitGateSubmission
} from "@/modules/governance/application/gate-submission-service";
import { createProjectFromTemplate } from "@/modules/projects/application/create-project";
import {
  createProjectMilestone,
  linkMilestoneTask
} from "@/modules/projects/application/milestone-service";
import { initializeProjectStructure } from "@/modules/projects/application/project-structure";

import { createPlanningTask, createWbsNode } from "../application/planning-service";
import {
  freezeG1PlanningBaseline,
  getPlanningBaseline,
  listPlanningBaselines
} from "../application/planning-baseline-service";
import { createTaskDependency, saveProjectCalendar } from "../application/schedule-network-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `baseline-admin-${suffix}`,
  projectManager: `baseline-pm-${suffix}`,
  quality: `baseline-quality-${suffix}`
};

function auditContext(
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

function baselineCommandRequest(url: string, body: unknown, key: string, actorId?: string) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      "x-request-id": `request-${key}`,
      ...(actorId ? { "x-apm-user-id": actorId } : {})
    },
    body: JSON.stringify(body)
  });
}

function baselineReadRequest(url: string, actorId?: string) {
  return new Request(url, {
    headers: actorId ? { "x-apm-user-id": actorId } : undefined
  });
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
            name: "执行计划基线批准",
            stageCode: "S0",
            requiredCheckerCodes: ["STAGE.AWAITING_GATE"],
            approval: { mode: "ANY", projectRoles: ["QUALITY"] }
          },
          {
            code: "G.PENDING",
            name: "未审批 Gate",
            stageCode: "S0",
            requiredCheckerCodes: ["STAGE.AWAITING_GATE"],
            approval: { mode: "ANY", projectRoles: ["QUALITY"] }
          },
          {
            code: "G.WRONG",
            name: "错误代码 Gate",
            stageCode: "S0",
            requiredCheckerCodes: ["STAGE.AWAITING_GATE"],
            approval: { mode: "ANY", projectRoles: ["QUALITY"] }
          },
          {
            code: "G.DU",
            name: "交付单元 Gate",
            stageCode: "S0",
            scope: "DELIVERY_UNIT",
            checkers: [{ code: "STAGE.AWAITING_GATE", version: 1 }],
            approval: { mode: "ANY", projectRoles: ["QUALITY"] }
          }
        ]
      };
    case "ROLE":
      return { roles: [{ code: "PROJECT_MANAGER", name: "项目经理", required: true }] };
    case "WBS":
      return { packages: [{ code: "S0.PLAN", name: "计划", stageCode: "S0", weight: 10 }] };
  }
}

async function seedTemplate() {
  const components = await Promise.all(
    (["STAGE", "GATE", "ROLE", "WBS"] as const).map(async (componentType) => {
      const code = `APM023.BASELINE.${componentType}.${suffix}`.toUpperCase();
      const draft = await saveTemplateComponentDraft({
        code,
        componentType,
        name: `${componentType} baseline integration`,
        content: componentDefinition(componentType),
        version: 0,
        reason: "创建计划基线测试组件",
        actorId: ids.admin,
        auditContext: auditContext(ids.admin, `component-draft-${componentType}`)
      });
      return (
        await publishTemplateComponent({
          code,
          version: draft.component.version,
          reason: "发布计划基线测试组件",
          actorId: ids.admin,
          auditContext: auditContext(ids.admin, `component-publish-${componentType}`)
        })
      ).publishedVersion;
    })
  );
  const code = `APM023.BASELINE.TEMPLATE.${suffix}`.toUpperCase();
  const draft = await saveProjectTemplateDraft({
    code,
    name: "APM-023 基线测试模板",
    components: components.map((component, position) => ({
      componentVersionId: component.id,
      componentType: component.componentType,
      slot: `${component.componentType}.${position}`,
      position
    })),
    version: 0,
    reason: "创建计划基线测试模板",
    actorId: ids.admin,
    auditContext: auditContext(ids.admin, "template-draft")
  });
  return {
    code,
    ...(await publishProjectTemplate({
      code,
      version: draft.template.version,
      reason: "发布计划基线测试模板",
      actorId: ids.admin,
      auditContext: auditContext(ids.admin, "template-publish")
    }))
  };
}

let template: Awaited<ReturnType<typeof seedTemplate>>;

async function seedReadyProject(label: string) {
  const created = await createProjectFromTemplate({
    code: `APM023.${label}.${suffix}`.toUpperCase(),
    name: `${label} planning baseline project`,
    departmentId: "engineering",
    templateCode: template.code,
    templateVersion: template.publishedVersion.version,
    templateChecksum: template.publishedVersion.checksum,
    reason: "创建计划基线测试项目",
    actorId: ids.admin,
    auditContext: auditContext(ids.admin, `project-${label}`)
  });
  const [projectManager] = await Promise.all([
    db.projectMember.create({
      data: {
        projectId: created.project.id,
        userId: ids.projectManager,
        projectRole: "PROJECT_MANAGER",
        departmentId: "engineering",
        assignedById: ids.admin
      }
    }),
    db.projectMember.create({
      data: {
        projectId: created.project.id,
        userId: ids.quality,
        projectRole: "QUALITY",
        departmentId: "engineering",
        assignedById: ids.admin
      }
    })
  ]);
  const structure = await initializeProjectStructure({
    projectId: created.project.id,
    projectVersion: created.project.version,
    projectType: "CUSTOMER_DELIVERY",
    equipmentShape: "SINGLE_MACHINE",
    deliveryUnits: [
      {
        code: "MACHINE.01",
        name: "一号机",
        unitType: "MACHINE",
        parentCode: null,
        position: 0
      }
    ],
    modules: [],
    reason: "初始化计划基线测试结构",
    actorId: ids.admin,
    auditContext: auditContext(ids.admin, `structure-${label}`, created.project.id)
  });
  const deliveryUnit = structure.deliveryUnits[0];
  if (!deliveryUnit) throw new Error("Expected a delivery unit.");
  const stage = await db.projectStage.findFirstOrThrow({
    where: { projectId: created.project.id, code: "S0" }
  });
  await Promise.all([
    db.projectStage.update({
      where: { id: stage.id },
      data: { status: "AWAITING_GATE", updatedById: ids.admin, version: { increment: 1 } }
    }),
    db.deliveryUnitStage.updateMany({
      where: {
        projectId: created.project.id,
        deliveryUnitId: deliveryUnit.id,
        projectStageId: stage.id
      },
      data: { status: "AWAITING_GATE", updatedById: ids.admin, version: { increment: 1 } }
    })
  ]);
  const wbs = await createWbsNode({
    projectId: created.project.id,
    code: "EXECUTION",
    name: "执行计划",
    parentId: null,
    position: 0,
    reason: "创建基线 WBS",
    actorId: ids.admin,
    auditContext: auditContext(ids.admin, `wbs-${label}`, created.project.id)
  });
  await createPlanningTask({
    projectId: created.project.id,
    code: "TASK.A",
    name: "计划任务 A",
    wbsNodeId: wbs.wbsNode.nodeId,
    ownerMembershipId: projectManager.id,
    position: 0,
    plannedStartAt: new Date("2026-08-06T00:00:00.000Z"),
    plannedFinishAt: new Date("2026-08-07T00:00:00.000Z"),
    plannedDurationMinutes: 480,
    weight: 50,
    reason: "创建基线任务 A",
    actorId: ids.admin,
    auditContext: auditContext(ids.admin, `task-a-${label}`, created.project.id)
  });
  await createPlanningTask({
    projectId: created.project.id,
    code: "TASK.B",
    name: "计划任务 B",
    wbsNodeId: wbs.wbsNode.nodeId,
    ownerMembershipId: projectManager.id,
    position: 1,
    plannedStartAt: new Date("2026-08-08T00:00:00.000Z"),
    plannedFinishAt: new Date("2026-08-09T00:00:00.000Z"),
    plannedDurationMinutes: 480,
    weight: 50,
    reason: "创建基线任务 B",
    actorId: ids.admin,
    auditContext: auditContext(ids.admin, `task-b-${label}`, created.project.id)
  });
  const tasks = await db.planningTask.findMany({
    where: { projectId: created.project.id },
    orderBy: { code: "asc" }
  });
  const [taskA, taskB] = tasks;
  if (!taskA || !taskB) throw new Error("Expected two planning tasks.");
  await createTaskDependency({
    projectId: created.project.id,
    predecessorTaskId: taskA.id,
    successorTaskId: taskB.id,
    dependencyType: "FS",
    lagMinutes: 0,
    reason: "创建基线任务依赖",
    actorId: ids.admin,
    auditContext: auditContext(ids.admin, `dependency-${label}`, created.project.id)
  });
  await saveProjectCalendar({
    projectId: created.project.id,
    version: 0,
    name: "项目标准日历",
    timeZone: "Asia/Shanghai",
    weeklyRules: [
      { dayOfWeek: 1, intervals: [{ startMinute: 480, endMinute: 1020 }] },
      { dayOfWeek: 2, intervals: [{ startMinute: 480, endMinute: 1020 }] }
    ],
    exceptions: [],
    reason: "创建基线项目日历",
    actorId: ids.admin,
    auditContext: auditContext(ids.admin, `calendar-${label}`, created.project.id)
  });
  const milestone = await createProjectMilestone({
    projectId: created.project.id,
    code: "G2",
    name: "设计冻结",
    position: 0,
    targetAt: new Date("2026-08-09T00:00:00.000Z"),
    reason: "创建基线里程碑",
    actorId: ids.admin,
    auditContext: auditContext(ids.admin, `milestone-${label}`, created.project.id)
  });
  await linkMilestoneTask({
    projectId: created.project.id,
    milestoneId: milestone.milestone.id,
    version: milestone.resourceVersion,
    taskId: taskB.id,
    reason: "关联基线里程碑任务",
    actorId: ids.admin,
    auditContext: auditContext(ids.admin, `milestone-link-${label}`, created.project.id)
  });
  const [
    dependency,
    calendar,
    calendarRevision,
    storedMilestone,
    milestoneTaskLink,
    scheduleState
  ] = await Promise.all([
    db.taskDependency.findFirstOrThrow({ where: { projectId: created.project.id } }),
    db.projectCalendar.findUniqueOrThrow({ where: { projectId: created.project.id } }),
    db.projectCalendarRevision.findFirstOrThrow({
      where: { projectId: created.project.id },
      orderBy: { revision: "desc" }
    }),
    db.projectMilestone.findFirstOrThrow({ where: { projectId: created.project.id, code: "G2" } }),
    db.projectMilestoneTaskLink.findFirstOrThrow({ where: { projectId: created.project.id } }),
    db.projectScheduleState.findUniqueOrThrow({ where: { projectId: created.project.id } })
  ]);

  return {
    project: created.project,
    deliveryUnit,
    wbs: await db.wbsNode.findUniqueOrThrow({ where: { id: wbs.wbsNode.nodeId } }),
    tasks: [taskA, taskB],
    dependency,
    calendar,
    calendarRevision,
    milestone: storedMilestone,
    milestoneTaskLink,
    planningInputVersion: scheduleState.inputVersion
  };
}

async function submitGate(
  facts: Awaited<ReturnType<typeof seedReadyProject>>,
  code: "G1" | "G.PENDING" | "G.WRONG" | "G.DU",
  approve: boolean
) {
  let gateInstance = await db.projectGateInstance.findFirst({
    where: { projectId: facts.project.id, gateDefinition: { code } }
  });
  if (!gateInstance) {
    const definition = await db.projectGateDefinition.findFirstOrThrow({
      where: { projectId: facts.project.id, code }
    });
    gateInstance = (
      await createGateInstance({
        projectId: facts.project.id,
        gateDefinitionId: definition.id,
        scope: "DELIVERY_UNIT",
        deliveryUnitId: facts.deliveryUnit.id,
        moduleId: null,
        actorId: ids.projectManager,
        auditContext: auditContext(
          ids.projectManager,
          `instance-${code}-${facts.project.id}`,
          facts.project.id
        )
      })
    ).gateInstance;
  }
  const checked = await runGateChecks({
    projectId: facts.project.id,
    gateInstanceId: gateInstance.id,
    version: gateInstance.version,
    reason: `执行 ${code} 检查`,
    actorId: ids.projectManager,
    auditContext: auditContext(
      ids.projectManager,
      `check-${code}-${facts.project.id}`,
      facts.project.id
    )
  });
  const submitted = await submitGateSubmission({
    projectId: facts.project.id,
    gateInstanceId: gateInstance.id,
    version: checked.resourceVersion,
    reason: `提交 ${code} 审批`,
    actorId: ids.projectManager,
    auditContext: auditContext(
      ids.projectManager,
      `submit-${code}-${facts.project.id}`,
      facts.project.id
    )
  });
  if (!approve) return submitted.submission.gateSubmissionId;
  const approved = await decideGateSubmission({
    projectId: facts.project.id,
    submissionId: submitted.submission.gateSubmissionId,
    version: submitted.resourceVersion,
    decision: "APPROVED",
    reason: `批准 ${code}`,
    actorId: ids.quality,
    auditContext: auditContext(ids.quality, `approve-${code}-${facts.project.id}`, facts.project.id)
  });
  return approved.submission.gateSubmissionId;
}

async function persistBaseline(
  facts: Awaited<ReturnType<typeof seedReadyProject>>,
  sourceGateSubmissionId: string
) {
  return db.planningBaseline.create({
    data: {
      projectId: facts.project.id,
      sourceGateSubmissionId,
      version: 1,
      planningInputVersion: facts.planningInputVersion,
      reason: "冻结 G1 执行计划基线",
      checksum: "a".repeat(64),
      createdById: ids.projectManager,
      wbsSnapshots: {
        create: {
          projectId: facts.project.id,
          sourceWbsNodeId: facts.wbs.id,
          snapshotJson: { sourceWbsNodeId: facts.wbs.id, code: facts.wbs.code }
        }
      },
      taskSnapshots: {
        create: facts.tasks.map((task) => ({
          projectId: facts.project.id,
          sourceTaskId: task.id,
          snapshotJson: { sourceTaskId: task.id, code: task.code }
        }))
      },
      dependencySnapshots: {
        create: {
          projectId: facts.project.id,
          sourceDependencyId: facts.dependency.id,
          snapshotJson: { sourceDependencyId: facts.dependency.id }
        }
      },
      milestoneSnapshots: {
        create: {
          projectId: facts.project.id,
          sourceMilestoneId: facts.milestone.id,
          snapshotJson: { sourceMilestoneId: facts.milestone.id, code: facts.milestone.code }
        }
      },
      milestoneTaskLinkSnapshots: {
        create: {
          projectId: facts.project.id,
          sourceMilestoneTaskLinkId: facts.milestoneTaskLink.id,
          snapshotJson: { sourceMilestoneTaskLinkId: facts.milestoneTaskLink.id }
        }
      },
      calendarSnapshot: {
        create: {
          projectId: facts.project.id,
          sourceCalendarId: facts.calendar.id,
          sourceCalendarRevisionId: facts.calendarRevision.id,
          snapshotJson: {
            sourceCalendarId: facts.calendar.id,
            sourceCalendarRevisionId: facts.calendarRevision.id
          }
        }
      }
    },
    include: {
      wbsSnapshots: true,
      taskSnapshots: true,
      dependencySnapshots: true,
      milestoneSnapshots: true,
      milestoneTaskLinkSnapshots: true,
      calendarSnapshot: true
    }
  });
}

function freezeInput(facts: Awaited<ReturnType<typeof seedReadyProject>>, operationId: string) {
  return {
    projectId: facts.project.id,
    planningInputVersion: facts.planningInputVersion,
    reason: "冻结 G1 执行计划基线",
    actorId: ids.projectManager,
    auditContext: auditContext(ids.projectManager, operationId, facts.project.id)
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function expectPostgresLockTimeout(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    const record = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
    const message = typeof record.message === "string" ? record.message : String(error);
    const hasPostgresLockTimeout =
      record.code === "55P03" || record.meta?.code === "55P03" || message.includes("55P03");
    expect(hasPostgresLockTimeout).toBe(true);
    expect(message).toMatch(/lock timeout/u);
    return;
  }
  throw new Error("Expected concurrent source write to fail with PostgreSQL lock timeout.");
}

const immutableTables = [
  { table: "planning_baselines", update: '"checksum" = "checksum"' },
  { table: "planning_baseline_wbs_snapshots", update: '"snapshot_json" = "snapshot_json"' },
  { table: "planning_baseline_task_snapshots", update: '"snapshot_json" = "snapshot_json"' },
  {
    table: "planning_baseline_dependency_snapshots",
    update: '"snapshot_json" = "snapshot_json"'
  },
  { table: "planning_baseline_milestone_snapshots", update: '"snapshot_json" = "snapshot_json"' },
  {
    table: "planning_baseline_milestone_task_link_snapshots",
    update: '"snapshot_json" = "snapshot_json"'
  },
  { table: "planning_baseline_calendar_snapshots", update: '"snapshot_json" = "snapshot_json"' }
] as const;

describeDatabase("APM-023 PostgreSQL G1 planning baseline facts", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `APM023-ADMIN-${suffix}`,
          name: "Planning baseline administrator",
          departmentId: "engineering"
        },
        {
          id: ids.projectManager,
          employeeNo: `APM023-PM-${suffix}`,
          name: "Planning baseline project manager",
          departmentId: "engineering"
        },
        {
          id: ids.quality,
          employeeNo: `APM023-QUALITY-${suffix}`,
          name: "Planning baseline quality reviewer",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `baseline-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        {
          id: `baseline-role-project-manager-${suffix}`,
          userId: ids.projectManager,
          roleId: "role-project-manager"
        },
        { id: `baseline-role-quality-${suffix}`, userId: ids.quality, roleId: "role-quality" }
      ]
    });
    template = await seedTemplate();
  });

  it("persists every immutable planning snapshot and rejects invalid Gate sources", async () => {
    const facts = await seedReadyProject("IMMUTABLE");
    const approvedG1SubmissionId = await submitGate(facts, "G1", true);
    const baseline = await persistBaseline(facts, approvedG1SubmissionId);

    expect(baseline).toMatchObject({
      projectId: facts.project.id,
      sourceGateSubmissionId: approvedG1SubmissionId,
      version: 1,
      planningInputVersion: facts.planningInputVersion,
      wbsSnapshots: [{ sourceWbsNodeId: facts.wbs.id }],
      dependencySnapshots: [{ sourceDependencyId: facts.dependency.id }],
      milestoneSnapshots: [{ sourceMilestoneId: facts.milestone.id }],
      milestoneTaskLinkSnapshots: [{ sourceMilestoneTaskLinkId: facts.milestoneTaskLink.id }],
      calendarSnapshot: {
        sourceCalendarId: facts.calendar.id,
        sourceCalendarRevisionId: facts.calendarRevision.id
      }
    });
    expect(baseline.taskSnapshots).toHaveLength(2);

    for (const { table, update } of immutableTables) {
      const where = table === "planning_baselines" ? '"id"' : '"baseline_id"';
      await expect(
        db.$executeRawUnsafe(`UPDATE "${table}" SET ${update} WHERE ${where} = $1`, baseline.id)
      ).rejects.toThrow(/immutable/u);
      await expect(
        db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${where} = $1`, baseline.id)
      ).rejects.toThrow(/immutable/u);
      const truncate =
        table === "planning_baselines"
          ? `TRUNCATE TABLE "${table}" CASCADE`
          : `TRUNCATE TABLE "${table}"`;
      await expect(db.$executeRawUnsafe(truncate)).rejects.toThrow(/immutable/u);
    }

    const foreign = await seedReadyProject("FOREIGN");
    const foreignG1SubmissionId = await submitGate(foreign, "G1", true);
    const mismatch = await seedReadyProject("MISMATCH");
    await expect(persistBaseline(mismatch, foreignG1SubmissionId)).rejects.toMatchObject({
      code: "P2003"
    });

    const invalidSources = await seedReadyProject("INVALID-SOURCES");
    const unapprovedSubmissionId = await submitGate(invalidSources, "G.PENDING", false);
    const wrongCodeSubmissionId = await submitGate(invalidSources, "G.WRONG", true);
    const deliveryUnitSubmissionId = await submitGate(invalidSources, "G.DU", true);
    for (const sourceGateSubmissionId of [
      unapprovedSubmissionId,
      wrongCodeSubmissionId,
      deliveryUnitSubmissionId
    ]) {
      await expect(persistBaseline(invalidSources, sourceGateSubmissionId)).rejects.toThrow(
        /planning baseline requires an approved project-scoped G1 submission/u
      );
    }
  });

  it("freezes G1 V1 transactionally and protects its immutable project-scoped snapshot", async () => {
    const facts = await seedReadyProject("SERVICE");
    const approvedG1SubmissionId = await submitGate(facts, "G1", true);

    const frozen = await freezeG1PlanningBaseline(freezeInput(facts, "freeze-service"));

    expect(frozen.baseline).toMatchObject({
      projectId: facts.project.id,
      sourceGateSubmissionId: approvedG1SubmissionId,
      version: 1,
      planningInputVersion: facts.planningInputVersion,
      wbsSnapshots: [{ sourceWbsNodeId: facts.wbs.id }],
      dependencySnapshots: [{ sourceDependencyId: facts.dependency.id }],
      milestoneSnapshots: [{ sourceMilestoneId: facts.milestone.id }],
      milestoneTaskLinkSnapshots: [{ sourceMilestoneTaskLinkId: facts.milestoneTaskLink.id }],
      calendarSnapshot: {
        sourceCalendarId: facts.calendar.id,
        sourceCalendarRevisionId: facts.calendarRevision.id
      }
    });
    expect(frozen.baseline.taskSnapshots).toHaveLength(2);
    await expect(
      db.auditLog.count({
        where: {
          action: "PLANNING_BASELINE_FROZEN",
          projectId: facts.project.id,
          objectId: frozen.baseline.id
        }
      })
    ).resolves.toBe(1);
    await expect(
      db.outboxEvent.count({
        where: {
          eventType: "planning.baseline.frozen",
          aggregateId: frozen.baseline.id
        }
      })
    ).resolves.toBe(1);

    const listed = await listPlanningBaselines({ projectId: facts.project.id });
    expect(listed.baselines).toEqual([frozen.baseline]);
    await expect(getPlanningBaseline(facts.project.id, frozen.baseline.id)).resolves.toEqual({
      baseline: frozen.baseline
    });

    await expect(
      freezeG1PlanningBaseline(freezeInput(facts, "freeze-second"))
    ).rejects.toMatchObject({ code: "PLANNING_BASELINE_V1_EXISTS", status: 409 });

    const stale = await seedReadyProject("STALE");
    await submitGate(stale, "G1", true);
    await expect(
      freezeG1PlanningBaseline({
        ...freezeInput(stale, "freeze-stale"),
        planningInputVersion: stale.planningInputVersion + 1
      })
    ).rejects.toMatchObject({ code: "PLANNING_BASELINE_INPUT_VERSION_CONFLICT", status: 409 });

    const noApprovedG1 = await seedReadyProject("MISSING-G1");
    await expect(
      freezeG1PlanningBaseline(freezeInput(noApprovedG1, "freeze-missing-g1"))
    ).rejects.toMatchObject({ code: "G1_BASELINE_APPROVAL_REQUIRED", status: 409 });

    const invalidApprovedGate = await seedReadyProject("INVALID-G1");
    await submitGate(invalidApprovedGate, "G.WRONG", true);
    await expect(
      freezeG1PlanningBaseline(freezeInput(invalidApprovedGate, "freeze-invalid-g1"))
    ).rejects.toMatchObject({ code: "G1_BASELINE_APPROVAL_REQUIRED", status: 409 });

    const foreign = await seedReadyProject("READ-ISOLATION");
    await expect(listPlanningBaselines({ projectId: foreign.project.id })).resolves.toEqual({
      baselines: []
    });
    await expect(getPlanningBaseline(foreign.project.id, frozen.baseline.id)).rejects.toMatchObject(
      {
        code: "PLANNING_BASELINE_NOT_FOUND",
        status: 404
      }
    );

    const rollback = await seedReadyProject("ROLLBACK");
    await submitGate(rollback, "G1", true);
    const [beforeBaselines, beforeAudits, beforeEvents] = await Promise.all([
      db.planningBaseline.count({ where: { projectId: rollback.project.id } }),
      db.auditLog.count({
        where: { action: "PLANNING_BASELINE_FROZEN", projectId: rollback.project.id }
      }),
      db.outboxEvent.count({ where: { eventType: "planning.baseline.frozen" } })
    ]);
    await expect(
      inTransaction(undefined, async (client) => {
        await freezeG1PlanningBaseline(freezeInput(rollback, "freeze-rollback"), client);
        throw new Error("abort planning baseline transaction");
      })
    ).rejects.toThrow("abort planning baseline transaction");
    await expect(
      db.planningBaseline.count({ where: { projectId: rollback.project.id } })
    ).resolves.toBe(beforeBaselines);
    await expect(
      db.auditLog.count({
        where: { action: "PLANNING_BASELINE_FROZEN", projectId: rollback.project.id }
      })
    ).resolves.toBe(beforeAudits);
    await expect(
      db.outboxEvent.count({ where: { eventType: "planning.baseline.frozen" } })
    ).resolves.toBe(beforeEvents);
  });

  it("rejects missing and structurally unready projects before freezing source snapshots", async () => {
    await expect(
      freezeG1PlanningBaseline({
        projectId: `missing-baseline-project-${suffix}`,
        planningInputVersion: 1,
        reason: "测试不存在项目的基线冻结",
        actorId: ids.admin,
        auditContext: auditContext(ids.admin, "freeze-missing-project")
      })
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND", status: 404 });

    const unready = await createProjectFromTemplate({
      code: `APM023.UNREADY.${suffix}`.toUpperCase(),
      name: "未完成结构的基线项目",
      departmentId: "engineering",
      templateCode: template.code,
      templateVersion: template.publishedVersion.version,
      templateChecksum: template.publishedVersion.checksum,
      reason: "创建未完成结构的基线测试项目",
      actorId: ids.admin,
      auditContext: auditContext(ids.admin, "project-unready")
    });
    await expect(
      freezeG1PlanningBaseline({
        projectId: unready.project.id,
        planningInputVersion: 1,
        reason: "测试未完成结构的基线冻结",
        actorId: ids.admin,
        auditContext: auditContext(ids.admin, "freeze-unready-project", unready.project.id)
      })
    ).rejects.toMatchObject({ code: "PROJECT_STRUCTURE_NOT_READY", status: 409 });
  });

  it("returns task snapshots in planned-position order even when source IDs sort differently", async () => {
    const facts = await seedReadyProject("CANONICAL-ORDER");
    const taskWithLeadingSourceId = await db.planningTask.create({
      data: {
        id: `00000000-baseline-task-${suffix}`,
        projectId: facts.project.id,
        wbsNodeId: facts.wbs.id,
        ownerMembershipId: facts.tasks[0]!.ownerMembershipId,
        code: "TASK.C",
        name: "计划任务 C",
        description: null,
        position: 2,
        plannedStartAt: new Date("2026-08-10T00:00:00.000Z"),
        plannedFinishAt: new Date("2026-08-11T00:00:00.000Z"),
        plannedDurationMinutes: 480,
        weight: 10,
        remainingDurationMinutes: 480,
        forecastFinishAt: new Date("2026-08-11T00:00:00.000Z"),
        createdById: ids.admin,
        updatedById: ids.admin
      }
    });
    const sourceIdOrder = await db.planningTask.findMany({
      where: { projectId: facts.project.id },
      select: { id: true },
      orderBy: { id: "asc" }
    });
    expect(sourceIdOrder[0]?.id).toBe(taskWithLeadingSourceId.id);

    await submitGate(facts, "G1", true);
    const frozen = await freezeG1PlanningBaseline(freezeInput(facts, "freeze-canonical-order"));

    expect(frozen.baseline.taskSnapshots.map(({ sourceTaskId }) => sourceTaskId)).toEqual([
      facts.tasks[0]!.id,
      facts.tasks[1]!.id,
      taskWithLeadingSourceId.id
    ]);
  });

  it("authorizes, freezes, replays, lists, and reads project-scoped planning baselines", async () => {
    const facts = await seedReadyProject("ROUTE");
    await submitGate(facts, "G1", true);
    const url = `http://localhost/api/projects/${facts.project.id}/planning-baselines`;
    const body = {
      planningInputVersion: facts.planningInputVersion,
      reason: "G1 已批准，冻结项目执行基线"
    };
    const context = { params: Promise.resolve({ projectId: facts.project.id }) };

    expect(
      await freezePlanningBaselineRoute(
        baselineCommandRequest(url, body, `baseline-route-unauth-${suffix}`),
        context
      )
    ).toHaveProperty("status", 401);
    expect(
      await freezePlanningBaselineRoute(
        baselineCommandRequest(url, body, `baseline-route-forbidden-${suffix}`, ids.quality),
        context
      )
    ).toHaveProperty("status", 403);

    const idempotencyKey = `baseline-route-freeze-${suffix}`;
    const first = await freezePlanningBaselineRoute(
      baselineCommandRequest(url, body, idempotencyKey, ids.projectManager),
      context
    );
    const replay = await freezePlanningBaselineRoute(
      baselineCommandRequest(url, body, idempotencyKey, ids.projectManager),
      context
    );
    const firstBody = (await first.json()) as { baseline: { id: string; projectId: string } };

    expect(first.status).toBe(201);
    expect(firstBody.baseline).toMatchObject({ projectId: facts.project.id });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    await expect(replay.json()).resolves.toEqual(firstBody);

    const list = await listPlanningBaselinesRoute(baselineReadRequest(url, ids.quality), context);
    const detail = await readPlanningBaselineRoute(
      baselineReadRequest(`${url}/${firstBody.baseline.id}`, ids.quality),
      {
        params: Promise.resolve({
          projectId: facts.project.id,
          baselineId: firstBody.baseline.id
        })
      }
    );
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      baselines: [{ id: firstBody.baseline.id }]
    });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      baseline: { id: firstBody.baseline.id, projectId: facts.project.id }
    });

    const foreign = await seedReadyProject("ROUTE-FOREIGN");
    const crossProjectDetail = await readPlanningBaselineRoute(
      baselineReadRequest(
        `http://localhost/api/projects/${foreign.project.id}/planning-baselines/${firstBody.baseline.id}`,
        ids.projectManager
      ),
      {
        params: Promise.resolve({
          projectId: foreign.project.id,
          baselineId: firstBody.baseline.id
        })
      }
    );
    expect(crossProjectDetail.status).toBe(404);
    await expect(crossProjectDetail.json()).resolves.toMatchObject({
      error: { code: "PLANNING_BASELINE_NOT_FOUND" }
    });
  });

  it("holds source inserts until the planning baseline transaction commits", async () => {
    const facts = await seedReadyProject("SOURCE-LOCK");
    await submitGate(facts, "G1", true);
    let releaseFreeze: () => void = () => undefined;
    const holdFreeze = new Promise<void>((resolve) => {
      releaseFreeze = resolve;
    });
    let markFrozen: (value: Awaited<ReturnType<typeof freezeG1PlanningBaseline>>) => void = () =>
      undefined;
    const frozen = new Promise<Awaited<ReturnType<typeof freezeG1PlanningBaseline>>>((resolve) => {
      markFrozen = resolve;
    });
    const concurrentDb = new PrismaClient();
    await concurrentDb.$connect();
    const freezeTransaction = inTransaction(undefined, async (client) => {
      const result = await freezeG1PlanningBaseline(
        freezeInput(facts, "freeze-source-lock"),
        client
      );
      markFrozen(result);
      await holdFreeze;
      return result;
    });

    try {
      const frozenResult = await withTimeout(
        frozen,
        5_000,
        "冻结事务未在预期时间内获得并保持源数据锁。"
      );
      await expectPostgresLockTimeout(
        concurrentDb.$transaction(async (client) => {
          await client.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
          return client.wbsNode.create({
            data: {
              projectId: facts.project.id,
              parentId: null,
              code: "CONCURRENT.BLOCKED",
              name: "并发新增 WBS",
              description: null,
              position: 1,
              createdById: ids.admin,
              updatedById: ids.admin
            }
          });
        })
      );

      expect(frozenResult.baseline.wbsSnapshots).toHaveLength(1);

      releaseFreeze();
      await expect(
        withTimeout(freezeTransaction, 5_000, "冻结事务未在释放后提交。")
      ).resolves.toMatchObject({ baseline: { id: frozenResult.baseline.id } });
      await expect(
        db.wbsNode.create({
          data: {
            projectId: facts.project.id,
            parentId: null,
            code: "CONCURRENT.AFTER",
            name: "锁释放后新增 WBS",
            description: null,
            position: 1,
            createdById: ids.admin,
            updatedById: ids.admin
          }
        })
      ).resolves.toMatchObject({ projectId: facts.project.id, code: "CONCURRENT.AFTER" });
    } finally {
      releaseFreeze();
      await freezeTransaction.catch(() => undefined);
      await concurrentDb.$disconnect();
    }
  });
});
