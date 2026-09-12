import { randomUUID } from "node:crypto";

import { describe, expect, it, beforeAll } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  publishProjectTemplate,
  publishTemplateComponent,
  saveProjectTemplateDraft,
  saveTemplateComponentDraft
} from "@/modules/configuration/application/template-service";
import { runGateChecks } from "@/modules/governance/application/gate-service";
import {
  decideGateSubmission,
  submitGateSubmission
} from "@/modules/governance/application/gate-submission-service";
import { createProjectFromTemplate } from "@/modules/projects/application/create-project";
import { initializeProjectStructure } from "@/modules/projects/application/project-structure";

import {
  createPlanningChange,
  decidePlanningChange,
  findPlanningChangeApproverIds,
  getPlanningChange,
  listPlanningChanges,
  submitPlanningChange
} from "../application/planning-change-service";
import { freezePlanningBaseline } from "../application/planning-baseline-service";
import { saveProjectCalendar } from "../application/schedule-network-service";
import { PlanningChangeError } from "../domain/planning-change";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `change-admin-${suffix}`,
  projectManager: `change-pm-${suffix}`,
  quality: `change-quality-${suffix}`,
  engineer: `change-engineer-${suffix}`
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
          }
        ]
      };
    case "ROLE":
      return {
        roles: [
          { code: "PROJECT_MANAGER", name: "项目经理", required: true },
          { code: "QUALITY", name: "质量", required: true },
          { code: "ENGINEER", name: "工程师", required: true }
        ]
      };
    case "WBS":
      return { packages: [{ code: "S0.PLAN", name: "计划", stageCode: "S0", weight: 10 }] };
  }
}

async function seedTemplate() {
  const components = await Promise.all(
    (["STAGE", "GATE", "ROLE", "WBS"] as const).map(async (componentType) => {
      const code = `APM024.CHANGE.${componentType}.${suffix}`.toUpperCase();
      const draft = await saveTemplateComponentDraft({
        code,
        componentType,
        name: `${componentType} planning change integration`,
        content: componentDefinition(componentType),
        version: 0,
        reason: "创建计划变更测试组件",
        actorId: ids.admin,
        auditContext: auditContext(ids.admin, `component-draft-${componentType}`)
      });
      return (
        await publishTemplateComponent({
          code,
          version: draft.component.version,
          reason: "发布计划变更测试组件",
          actorId: ids.admin,
          auditContext: auditContext(ids.admin, `component-publish-${componentType}`)
        })
      ).publishedVersion;
    })
  );
  const code = `APM024.CHANGE.TEMPLATE.${suffix}`.toUpperCase();
  const draft = await saveProjectTemplateDraft({
    code,
    name: "APM-024 计划变更测试模板",
    components: components.map((component, position) => ({
      componentVersionId: component.id,
      componentType: component.componentType,
      slot: `${component.componentType}.${position}`,
      position
    })),
    version: 0,
    reason: "创建计划变更测试模板",
    actorId: ids.admin,
    auditContext: auditContext(ids.admin, "template-draft")
  });
  return {
    code,
    ...(await publishProjectTemplate({
      code,
      version: draft.template.version,
      reason: "发布计划变更测试模板",
      actorId: ids.admin,
      auditContext: auditContext(ids.admin, "template-publish")
    }))
  };
}

let template: Awaited<ReturnType<typeof seedTemplate>>;

/**
 * 项目创建者会被自动写成 PROJECT_MANAGER 成员。用 admin 建项目会多出一个不在
 * 审批角色声明内、却仍属于 PROJECT_MANAGER 的冻结审批人，ALL 会签永远凑不齐；
 * 所以由项目经理本人建项目，成员集合与声明的审批角色一致。
 *
 * 计划输入版本来自 project_schedule_states，该行只由排程重算服务创建：全新项目
 * 读不到任何行，冻结基线会以 PLANNING_BASELINE_INPUT_VERSION_CONFLICT 拒绝。
 */
async function seedReadyProject(
  label: string,
  planningInputVersion = 1
): Promise<{ projectId: string; planningInputVersion: number }> {
  const created = await createProjectFromTemplate({
    code: `APM024.${label}.${suffix}`.toUpperCase(),
    name: `${label} planning change project`,
    departmentId: "engineering",
    templateCode: template.code,
    templateVersion: template.publishedVersion.version,
    templateChecksum: template.publishedVersion.checksum,
    reason: "创建计划变更测试项目",
    actorId: ids.projectManager,
    auditContext: auditContext(ids.projectManager, `project-${label}`)
  });
  await Promise.all([
    db.projectMember.create({
      data: {
        projectId: created.project.id,
        userId: ids.quality,
        projectRole: "QUALITY",
        departmentId: "engineering",
        assignedById: ids.projectManager
      }
    }),
    db.projectScheduleState.upsert({
      where: { projectId: created.project.id },
      create: { projectId: created.project.id, inputVersion: planningInputVersion },
      update: { inputVersion: planningInputVersion }
    })
  ]);
  await initializeProjectStructure({
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
    reason: "初始化计划变更测试结构",
    actorId: ids.admin,
    auditContext: auditContext(ids.admin, `structure-${label}`, created.project.id)
  });
  const scheduleState = await db.projectScheduleState.findUniqueOrThrow({
    where: { projectId: created.project.id },
    select: { inputVersion: true }
  });
  return { projectId: created.project.id, planningInputVersion: scheduleState.inputVersion };
}

/**
 * 冻结计划基线要求存在「已批准的项目级 G1 提交」（planning-baseline.ts:290）。
 * 模板的 GATE 组件默认物化为 PROJECT 范围，实例在创建项目时已建好，所以这里只需要
 * 把 S0 阶段推进到 AWAITING_GATE，再走一遍检查 → 提交 → 批准。
 */
async function approveProjectG1(projectId: string, label: string) {
  // 冻结基线还要求「启用的当前工作日历」（planning-baseline.ts:296）。
  await saveProjectCalendar({
    projectId,
    version: 0,
    name: "计划变更测试日历",
    timeZone: "Asia/Shanghai",
    weeklyRules: [{ dayOfWeek: 1, intervals: [{ startMinute: 480, endMinute: 1020 }] }],
    exceptions: [],
    reason: `创建日历 ${label}`,
    actorId: ids.projectManager,
    auditContext: auditContext(ids.projectManager, `calendar-${label}`, projectId)
  });
  const stage = await db.projectStage.findFirstOrThrow({ where: { projectId, code: "S0" } });
  await db.projectStage.update({
    where: { id: stage.id },
    data: { status: "AWAITING_GATE", updatedById: ids.projectManager, version: { increment: 1 } }
  });
  const gateInstance = await db.projectGateInstance.findFirstOrThrow({
    where: {
      projectId,
      scope: "PROJECT",
      gateDefinition: { code: "G1" }
    }
  });
  const checked = await runGateChecks({
    projectId,
    gateInstanceId: gateInstance.id,
    version: gateInstance.version,
    reason: `执行 G1 检查 ${label}`,
    actorId: ids.projectManager,
    auditContext: auditContext(ids.projectManager, `check-g1-${label}`, projectId)
  });
  const submitted = await submitGateSubmission({
    projectId,
    gateInstanceId: gateInstance.id,
    version: checked.resourceVersion,
    reason: `提交 G1 审批 ${label}`,
    actorId: ids.projectManager,
    auditContext: auditContext(ids.projectManager, `submit-g1-${label}`, projectId)
  });
  const approved = await decideGateSubmission({
    projectId,
    submissionId: submitted.submission.gateSubmissionId,
    version: submitted.resourceVersion,
    decision: "APPROVED",
    reason: `批准 G1 ${label}`,
    actorId: ids.quality,
    auditContext: auditContext(ids.quality, `approve-g1-${label}`, projectId)
  });
  // 保存日历会推进项目计划输入版本，调用方必须用这里回读的值，而不是 seed 时读到的旧值。
  const scheduleState = await db.projectScheduleState.findUniqueOrThrow({
    where: { projectId },
    select: { inputVersion: true }
  });
  return {
    submissionId: approved.submission.gateSubmissionId,
    planningInputVersion: scheduleState.inputVersion
  };
}

function command(projectId: string, actorId: string, operationId: string) {
  return {
    projectId,
    actorId,
    auditContext: auditContext(actorId, operationId, projectId)
  };
}

async function createChange(
  projectId: string,
  label: string,
  classification: "FORECAST_ONLY" | "FORMAL" = "FORMAL",
  planningInputVersion = 1
) {
  return createPlanningChange({
    ...command(projectId, ids.projectManager, `create-${label}`),
    classification,
    reason: `创建计划变更 ${label}`,
    planningInputVersion,
    resultingPlanningInputVersion: planningInputVersion + 1,
    delta: { tasks: [{ code: "TASK.A", plannedFinishAt: "2026-09-20" }] }
  });
}

async function submitChange(changeId: string, projectId: string, label: string, version: number) {
  return submitPlanningChange({
    ...command(projectId, ids.projectManager, `submit-${label}`),
    changeId,
    version,
    reason: `提交计划变更 ${label}`,
    approvalMode: "ALL",
    approverProjectRoles: ["PROJECT_MANAGER", "QUALITY"]
  });
}

function expectPlanningChangeError(error: unknown, code: string) {
  expect(error).toBeInstanceOf(PlanningChangeError);
  expect((error as PlanningChangeError).code).toBe(code);
}

describeDatabase("APM-024 PostgreSQL planning change facts", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `APM024-ADMIN-${suffix}`,
          name: "Planning change administrator",
          departmentId: "engineering"
        },
        {
          id: ids.projectManager,
          employeeNo: `APM024-PM-${suffix}`,
          name: "Planning change project manager",
          departmentId: "engineering"
        },
        {
          id: ids.quality,
          employeeNo: `APM024-QUALITY-${suffix}`,
          name: "Planning change quality reviewer",
          departmentId: "engineering"
        },
        {
          id: ids.engineer,
          employeeNo: `APM024-ENGINEER-${suffix}`,
          name: "Planning change engineer",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `change-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        {
          id: `change-role-project-manager-${suffix}`,
          userId: ids.projectManager,
          roleId: "role-project-manager"
        },
        { id: `change-role-quality-${suffix}`, userId: ids.quality, roleId: "role-quality" }
      ]
    });
    template = await seedTemplate();
  });

  it("serializes concurrent draft creation and surfaces the loser as a conflict", async () => {
    const { projectId } = await seedReadyProject("CONCURRENT");

    // 既有行为：nextChangeSequence 只读 max(sequence) 后 +1，不取锁。
    // 并发创建时两个事务会算出同一个 code，由唯一约束兜底。
    const settled = await Promise.allSettled([
      createChange(projectId, "race-a"),
      createChange(projectId, "race-b")
    ]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");

    for (const result of rejected) {
      expectPlanningChangeError(
        (result as PromiseRejectedResult).reason,
        "PLANNING_CHANGE_CONFLICT"
      );
    }
    // 冲突只会以 PLANNING_CHANGE_CONFLICT 报给调用方，不会自动重试。
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.length + rejected.length).toBe(2);

    const changes = await db.planningChange.findMany({
      where: { projectId },
      orderBy: { sequence: "asc" },
      select: { sequence: true, code: true }
    });
    expect(new Set(changes.map((change) => change.code)).size).toBe(changes.length);
    expect(changes[0]?.sequence).toBe(1);
  });

  it("increments the sequence for a sequential create and links the previous change", async () => {
    const { projectId } = await seedReadyProject("SEQUENCE");
    const first = await createChange(projectId, "sequence-a");
    const second = await createChange(projectId, "sequence-b");

    expect(first.change).toMatchObject({ sequence: 1, code: "PC-0001", previousChangeId: null });
    expect(second.change).toMatchObject({
      sequence: 2,
      code: "PC-0002",
      previousChangeId: first.change.id
    });
    await expect(listPlanningChanges(projectId)).resolves.toMatchObject({
      changes: [
        expect.objectContaining({ id: second.change.id }),
        expect.objectContaining({ id: first.change.id })
      ]
    });
  });

  it("freezes the approver snapshot on submit and rejects a second decision by the same approver", async () => {
    const { projectId } = await seedReadyProject("APPROVAL");
    const created = await createChange(projectId, "approval");
    const submitted = await submitChange(created.change.id, projectId, "approval", 1);
    expect(submitted.change).toMatchObject({ status: "SUBMITTED", approvalMode: "ALL" });

    await expect(
      decidePlanningChange({
        ...command(projectId, ids.projectManager, "decide-approval"),
        changeId: created.change.id,
        version: 2,
        decision: "APPROVED",
        reason: "项目批准"
      })
    ).resolves.toMatchObject({ change: { status: "SUBMITTED" } });

    await expect(
      decidePlanningChange({
        ...command(projectId, ids.projectManager, "decide-approval-again"),
        changeId: created.change.id,
        version: 3,
        decision: "APPROVED",
        reason: "重复批准"
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectPlanningChangeError(error, "PLANNING_CHANGE_APPROVAL_ALREADY_RECORDED");
      return true;
    });
  });

  it("rejects a decision from a user who is not a frozen approver", async () => {
    const { projectId } = await seedReadyProject("FORBIDDEN");
    const created = await createChange(projectId, "forbidden");
    await submitChange(created.change.id, projectId, "forbidden", 1);

    await expect(
      decidePlanningChange({
        ...command(projectId, ids.engineer, "decide-forbidden"),
        changeId: created.change.id,
        version: 2,
        decision: "APPROVED",
        reason: "越权批准"
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectPlanningChangeError(error, "PLANNING_CHANGE_APPROVAL_FORBIDDEN");
      return true;
    });
  });

  // 自批规则：提交人自己可以是审批人，但资格来自冻结审批人快照（= 被声明的审批项目角色成员），
  // 而不是「是否为提交人」。因此断言两侧：有审批权限的提交人可自批；无审批权限的提交人被拒。
  it("allows the submitter to approve their own change when they hold an approval role", async () => {
    const { projectId } = await seedReadyProject("SELF-APPROVE");
    // FORECAST_ONLY 不绑定基线，避免为这条规则补一整套 V1/G1 前置。
    const created = await createChange(projectId, "self-approve", "FORECAST_ONLY");
    const submitted = await submitChange(created.change.id, projectId, "self-approve", 1);
    expect(submitted.change).toMatchObject({
      status: "SUBMITTED",
      submittedById: ids.projectManager
    });

    // ALL 会签：提交人（PROJECT_MANAGER）先批，再由 QUALITY 批完。
    await expect(
      decidePlanningChange({
        ...command(projectId, ids.projectManager, "self-approve-pm"),
        changeId: created.change.id,
        version: 2,
        decision: "APPROVED",
        reason: "项目经理自批"
      })
    ).resolves.toMatchObject({ change: { status: "SUBMITTED" } });

    await expect(
      decidePlanningChange({
        ...command(projectId, ids.quality, "self-approve-quality"),
        changeId: created.change.id,
        version: 3,
        decision: "APPROVED",
        reason: "质量会签"
      })
    ).resolves.toMatchObject({ change: { status: "APPROVED" } });
  });

  it("rejects the submitter's own decision when they hold no approval role", async () => {
    const { projectId } = await seedReadyProject("SELF-DENIED");
    // admin 是提交人，但不在声明的审批角色（PROJECT_MANAGER / QUALITY）内。
    const created = await createPlanningChange({
      ...command(projectId, ids.admin, "create-self-denied"),
      classification: "FORECAST_ONLY",
      reason: "创建计划变更 self-denied",
      planningInputVersion: 1,
      resultingPlanningInputVersion: 2,
      delta: { tasks: [{ code: "TASK.A", plannedFinishAt: "2026-09-20" }] }
    });
    await submitChange(created.change.id, projectId, "self-denied", 1);

    await expect(
      decidePlanningChange({
        ...command(projectId, ids.admin, "decide-self-denied"),
        changeId: created.change.id,
        version: 2,
        decision: "APPROVED",
        reason: "提交人自批但无审批角色"
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectPlanningChangeError(error, "PLANNING_CHANGE_APPROVAL_FORBIDDEN");
      return true;
    });
  });

  it("never binds a baseline for a FORECAST_ONLY change approved by everyone", async () => {
    const { projectId, planningInputVersion } = await seedReadyProject("FORECAST");
    const created = await createChange(
      projectId,
      "forecast",
      "FORECAST_ONLY",
      planningInputVersion
    );
    await submitChange(created.change.id, projectId, "forecast", 1);

    await decidePlanningChange({
      ...command(projectId, ids.projectManager, "decide-forecast-pm"),
      changeId: created.change.id,
      version: 2,
      decision: "APPROVED",
      reason: "项目经理批准普通延期"
    });
    const decided = await decidePlanningChange({
      ...command(projectId, ids.quality, "decide-forecast-quality"),
      changeId: created.change.id,
      version: 3,
      decision: "APPROVED",
      reason: "质量批准普通延期"
    });

    expect(decided.change).toMatchObject({ status: "APPROVED", resultingBaselineId: null });
    expect(decided.baselineId).toBeNull();
    await expect(db.planningBaseline.count({ where: { projectId } })).resolves.toBe(0);
  });

  it("refuses to generate baseline V2 while V1 is missing", async () => {
    const { projectId, planningInputVersion } = await seedReadyProject("V2-WITHOUT-V1");

    // 版本先对上，V1 缺失才会作为下一个检查暴露出来。
    await expect(
      freezePlanningBaseline({
        projectId,
        version: 2,
        planningInputVersion,
        reason: "缺少 V1 时冻结 V2",
        actorId: ids.projectManager,
        auditContext: auditContext(ids.projectManager, "freeze-v2-without-v1", projectId)
      })
    ).rejects.toMatchObject({ code: "PLANNING_BASELINE_V1_REQUIRED" });
  });

  it("generates baseline V2 once for an approved FORMAL change and rejects a duplicate freeze", async () => {
    const { projectId } = await seedReadyProject("FORMAL-V2");
    const { planningInputVersion: approvedVersion } = await approveProjectG1(
      projectId,
      "formal-v2"
    );
    const v1 = await freezePlanningBaseline({
      projectId,
      version: 1,
      planningInputVersion: approvedVersion,
      reason: "先冻结 V1",
      actorId: ids.projectManager,
      auditContext: auditContext(ids.projectManager, "freeze-v1", projectId)
    });
    // 正式变更把输入版本再推进一步：声明的生效版本必须等于批准后项目上的实际版本。
    const changeVersion = approvedVersion + 1;
    await db.projectScheduleState.update({
      where: { projectId },
      data: { inputVersion: changeVersion }
    });
    const created = await createChange(projectId, "formal-v2", "FORMAL", approvedVersion);
    await submitChange(created.change.id, projectId, "formal-v2", 1);
    await decidePlanningChange({
      ...command(projectId, ids.projectManager, "decide-formal-pm"),
      changeId: created.change.id,
      version: 2,
      decision: "APPROVED",
      reason: "项目经理批准正式变更"
    });
    const decided = await decidePlanningChange({
      ...command(projectId, ids.quality, "decide-formal-quality"),
      changeId: created.change.id,
      version: 3,
      decision: "APPROVED",
      reason: "质量批准正式变更"
    });

    expect(decided.change).toMatchObject({ status: "APPROVED" });
    expect(decided.baselineId).toBeTruthy();
    await expect(db.planningBaseline.count({ where: { projectId, version: 2 } })).resolves.toBe(1);
    await expect(db.planningBaseline.count({ where: { projectId, version: 1 } })).resolves.toBe(1);
    expect(v1.baseline.id).not.toBe(decided.baselineId);

    await expect(
      freezePlanningBaseline({
        projectId,
        version: 2,
        planningInputVersion: changeVersion,
        reason: "重复冻结 V2",
        actorId: ids.projectManager,
        auditContext: auditContext(ids.projectManager, "freeze-v2-again", projectId)
      })
    ).rejects.toMatchObject({ code: "PLANNING_BASELINE_V2_EXISTS" });
  });

  it("keeps every read and write project-scoped (IDOR defaults to refusal)", async () => {
    const { projectId: owner } = await seedReadyProject("IDOR-OWNER");
    const { projectId: other } = await seedReadyProject("IDOR-OTHER");
    const created = await createChange(owner, "idor");

    await expect(getPlanningChange(other, created.change.id)).rejects.toMatchObject({
      code: "PLANNING_CHANGE_NOT_FOUND",
      status: 404
    });
    await expect(findPlanningChangeApproverIds(other, created.change.id)).resolves.toBeNull();
    await expect(findPlanningChangeApproverIds(owner, created.change.id)).resolves.toEqual([]);
    await expect(listPlanningChanges(other)).resolves.toEqual({ changes: [] });
    await expect(
      submitPlanningChange({
        ...command(other, ids.projectManager, "submit-idor"),
        changeId: created.change.id,
        version: 1,
        reason: "跨项目提交",
        approvalMode: "ALL",
        approverProjectRoles: ["PROJECT_MANAGER"]
      })
    ).rejects.toMatchObject({ code: "PLANNING_CHANGE_NOT_FOUND", status: 404 });
  });

  it("rejects a stale resource version instead of overwriting", async () => {
    const { projectId } = await seedReadyProject("STALE");
    const created = await createChange(projectId, "stale");
    await submitChange(created.change.id, projectId, "stale", 1);

    await expect(
      submitPlanningChange({
        ...command(projectId, ids.projectManager, "submit-stale"),
        changeId: created.change.id,
        version: 1,
        reason: "过期版本重复提交",
        approvalMode: "ANY",
        approverProjectRoles: ["QUALITY"]
      })
    ).rejects.toMatchObject({ code: "PLANNING_CHANGE_VERSION_CONFLICT" });
  });
});
