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

import { upgradeProjectClosurePolicy } from "../application/project-closure-policy-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const adminId = `closure-policy-admin-${suffix}`;

function context(operationId: string, projectId: string | null = null): AuditContext {
  return {
    actorId: adminId,
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

function componentContent(type: "STAGE" | "GATE" | "ROLE" | "WBS") {
  switch (type) {
    case "STAGE":
      return {
        stages: Array.from({ length: 9 }, (_, sequence) => ({
          code: `S${sequence}`,
          name: `阶段 ${sequence}`,
          sequence
        }))
      };
    case "GATE":
      return {
        gates: [
          {
            code: "G1",
            name: "执行基线批准",
            stageCode: "S0",
            scope: "PROJECT",
            checkers: [{ code: "DOCUMENTS.COMPLETE", version: 1 }]
          }
        ]
      };
    case "ROLE":
      return { roles: [{ code: "PROJECT_MANAGER", name: "项目经理", required: true }] };
    case "WBS":
      return {
        packages: [{ code: "S0.KICKOFF", name: "项目启动", stageCode: "S0", weight: 10 }]
      };
  }
}

async function seedTemplate(input: {
  label: string;
  gates?: Array<{
    code: string;
    name: string;
    stageCode: string;
    scope: "PROJECT";
    checkers: Array<{ code: string; version: number }>;
  }>;
}) {
  const components = await Promise.all(
    (["STAGE", "GATE", "ROLE", "WBS"] as const).map(async (componentType) => {
      const code = `CLOSURE.POLICY.${input.label}.${componentType}.${suffix}`.toUpperCase();
      const draft = await saveTemplateComponentDraft({
        code,
        componentType,
        name: `${componentType} closure policy integration`,
        content:
          componentType === "GATE" && input.gates
            ? { gates: input.gates }
            : componentContent(componentType),
        version: 0,
        reason: "创建结项策略集成测试组件",
        actorId: adminId,
        auditContext: context(`component-draft-${componentType}`)
      });
      return (
        await publishTemplateComponent({
          code,
          version: draft.component.version,
          reason: "发布结项策略集成测试组件",
          actorId: adminId,
          auditContext: context(`component-publish-${componentType}`)
        })
      ).publishedVersion;
    })
  );
  const code = `CLOSURE.POLICY.${input.label}.TEMPLATE.${suffix}`.toUpperCase();
  const draft = await saveProjectTemplateDraft({
    code,
    name: "Closure policy auxiliary template",
    components: components.map((component, position) => ({
      componentVersionId: component.id,
      componentType: component.componentType,
      slot: `${component.componentType}.${position}`,
      position
    })),
    version: 0,
    reason: "创建结项策略集成测试模板",
    actorId: adminId,
    auditContext: context("template-draft")
  });
  const published = await publishProjectTemplate({
    code,
    version: draft.template.version,
    reason: "发布结项策略集成测试模板",
    actorId: adminId,
    auditContext: context("template-publish")
  });
  return {
    code,
    version: published.publishedVersion.version,
    checksum: published.publishedVersion.checksum
  };
}

async function seedLegacyProject(
  template: Awaited<ReturnType<typeof seedTemplate>>,
  label: string
) {
  const created = await createProjectFromTemplate({
    code: `CLOSURE.POLICY.${label}.${suffix}`.toUpperCase(),
    name: `Closure policy ${label}`,
    departmentId: "engineering",
    templateCode: template.code,
    templateVersion: template.version,
    templateChecksum: template.checksum,
    reason: "创建存量关项策略项目",
    actorId: adminId,
    auditContext: context(`project-${label}`)
  });
  const [snapshot, gateComponent, stage] = await Promise.all([
    db.projectTemplateSnapshot.findUniqueOrThrow({ where: { projectId: created.project.id } }),
    db.projectTemplateSnapshotComponent.findFirstOrThrow({
      where: { snapshot: { projectId: created.project.id }, componentType: "GATE" }
    }),
    db.projectStage.findUniqueOrThrow({
      where: { projectId_code: { projectId: created.project.id, code: "S8" } }
    })
  ]);
  const legacyDefinition = await db.projectGateDefinition.create({
    data: {
      projectId: created.project.id,
      sourceSnapshotComponentId: gateComponent.id,
      projectStageId: stage.id,
      revision: 1,
      code: "G9",
      name: "历史项目结项",
      scope: "PROJECT",
      definitionJson: { approvalMode: "ALL" },
      checkerBindingsJson: [{ code: "CLOSURE.ARCHIVE.G9", version: 1 }],
      definitionChecksum: "a".repeat(64),
      materializedById: adminId
    }
  });
  const legacyInstance = await db.projectGateInstance.create({
    data: {
      projectId: created.project.id,
      gateDefinitionId: legacyDefinition.id,
      projectStageId: stage.id,
      scope: "PROJECT",
      createdById: adminId,
      updatedById: adminId
    }
  });
  return { project: created.project, snapshot, legacyDefinition, legacyInstance };
}

describeDatabase("APM-104 PostgreSQL project closure policies", () => {
  let auxiliaryTemplate: Awaited<ReturnType<typeof seedTemplate>>;
  let closureTemplate: Awaited<ReturnType<typeof seedTemplate>>;

  beforeAll(async () => {
    await db.user.create({
      data: {
        id: adminId,
        employeeNo: `CLOSURE-POLICY-ADMIN-${suffix}`,
        name: "结项策略管理员",
        departmentId: "engineering"
      }
    });
    auxiliaryTemplate = await seedTemplate({ label: "AUXILIARY" });
    closureTemplate = await seedTemplate({
      label: "CLOSURE-V2",
      gates: [
        {
          code: "G9",
          name: "项目结项",
          stageCode: "S8",
          scope: "PROJECT",
          checkers: [
            { code: "CLOSURE.ARCHIVE.G9", version: 2 },
            { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
          ]
        }
      ]
    });
  });

  it("keeps an auxiliary customer-delivery project policy-free", async () => {
    const created = await createProjectFromTemplate({
      code: `CLOSURE.POLICY.AUXILIARY.${suffix}`.toUpperCase(),
      name: "Auxiliary customer-delivery project",
      departmentId: "engineering",
      templateCode: auxiliaryTemplate.code,
      templateVersion: auxiliaryTemplate.version,
      templateChecksum: auxiliaryTemplate.checksum,
      reason: "创建辅助交付项目",
      actorId: adminId,
      auditContext: context("auxiliary-project")
    });
    const initialized = await initializeProjectStructure({
      projectId: created.project.id,
      projectVersion: created.project.version,
      projectType: "CUSTOMER_DELIVERY",
      equipmentShape: "SINGLE_MACHINE",
      deliveryUnits: [],
      modules: [],
      reason: "初始化辅助交付项目",
      actorId: adminId,
      auditContext: context("auxiliary-project-structure", created.project.id)
    });

    expect(initialized.project).toMatchObject({ projectType: "CUSTOMER_DELIVERY" });
    await expect(
      db.projectClosurePolicy.count({ where: { projectId: created.project.id } })
    ).resolves.toBe(0);
  });

  it("refuses to initialize a V2 closure project as internal R&D", async () => {
    const created = await createProjectFromTemplate({
      code: `CLOSURE.POLICY.RND.${suffix}`.toUpperCase(),
      name: "Closure policy internal R&D rejection",
      departmentId: "engineering",
      templateCode: closureTemplate.code,
      templateVersion: closureTemplate.version,
      templateChecksum: closureTemplate.checksum,
      reason: "创建关项项目",
      actorId: adminId,
      auditContext: context("closure-rnd-project")
    });
    await expect(
      initializeProjectStructure({
        projectId: created.project.id,
        projectVersion: created.project.version,
        projectType: "INTERNAL_RND",
        equipmentShape: null,
        deliveryUnits: [],
        modules: [],
        reason: "内部研发不能携带客户关项策略",
        actorId: adminId,
        auditContext: context("closure-rnd-structure", created.project.id)
      })
    ).rejects.toMatchObject({ code: "INTERNAL_RND_CLOSURE_POLICY_FORBIDDEN", status: 409 });
    await expect(
      db.project.findUniqueOrThrow({ where: { id: created.project.id } })
    ).resolves.toMatchObject({ projectType: "LEGACY", structureStatus: "UNCONFIGURED" });
  });

  it("upgrades a legacy project append-only, replays idempotently, and keeps one active policy", async () => {
    const seeded = await seedLegacyProject(auxiliaryTemplate, "UPGRADE");
    const input = {
      projectId: seeded.project.id,
      sourceTemplateSnapshotId: seeded.snapshot.id,
      sourceGateDefinitionId: seeded.legacyDefinition.id,
      gateInstanceId: seeded.legacyInstance.id,
      expectedPolicyVersion: 0,
      reason: "升级为 V2 关项策略",
      actorId: adminId,
      idempotencyKey: `closure-upgrade-${suffix}`,
      auditContext: context("closure-upgrade", seeded.project.id)
    };
    const first = await upgradeProjectClosurePolicy(input);
    const replay = await upgradeProjectClosurePolicy(input);
    const firstV2Definition = await db.projectGateDefinition.findUniqueOrThrow({
      where: {
        projectId_code_revision: { projectId: seeded.project.id, code: "G9", revision: 2 }
      },
      include: { instances: true }
    });
    const beforeSecondUpgrade = await db.projectClosurePolicy.findUniqueOrThrow({
      where: { projectId: seeded.project.id }
    });
    const second = await upgradeProjectClosurePolicy({
      ...input,
      sourceGateDefinitionId: firstV2Definition.id,
      gateInstanceId: firstV2Definition.instances[0]!.id,
      expectedPolicyVersion: beforeSecondUpgrade.version,
      reason: "再次升级结项策略",
      idempotencyKey: `closure-upgrade-second-${suffix}`,
      auditContext: context("closure-upgrade-second", seeded.project.id)
    });
    const definitions = await db.projectGateDefinition.findMany({
      where: { projectId: seeded.project.id, code: "G9" },
      include: { instances: true },
      orderBy: { revision: "asc" }
    });
    const policy = await db.projectClosurePolicy.findUniqueOrThrow({
      where: { projectId: seeded.project.id },
      include: { versions: { orderBy: { versionNo: "asc" } } }
    });

    expect(replay).toMatchObject({ replayed: true, policyVersionId: first.policyVersionId });
    expect(definitions).toHaveLength(3);
    expect(definitions[0]).toMatchObject({
      id: seeded.legacyDefinition.id,
      revision: 1,
      checkerBindingsJson: [{ code: "CLOSURE.ARCHIVE.G9", version: 1 }]
    });
    expect(definitions[1]).toMatchObject({
      revision: 2,
      checkerBindingsJson: [
        { code: "CLOSURE.ARCHIVE.G9", version: 2 },
        { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
      ],
      instances: [
        expect.objectContaining({
          closurePolicyVersionId: first.policyVersionId,
          archiveSourceFormulaVersion: "V2"
        })
      ]
    });
    expect(definitions[2]).toMatchObject({
      revision: 3,
      checkerBindingsJson: [
        { code: "CLOSURE.ARCHIVE.G9", version: 2 },
        { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
      ],
      instances: [
        expect.objectContaining({
          closurePolicyVersionId: second.policyVersionId,
          archiveSourceFormulaVersion: "V2"
        })
      ]
    });
    expect(policy.versions).toMatchObject([
      { id: first.policyVersionId, status: "SUPERSEDED" },
      { id: second.policyVersionId, status: "ACTIVE" }
    ]);
    expect(policy.currentVersionId).toBe(second.policyVersionId);
    await expect(
      db.projectClosurePolicyVersion.count({
        where: { projectId: seeded.project.id, status: "ACTIVE" }
      })
    ).resolves.toBe(1);
  });

  it("rejects stale and concurrent legacy upgrades without a second active policy", async () => {
    const seeded = await seedLegacyProject(auxiliaryTemplate, "CONCURRENT");
    const base = {
      projectId: seeded.project.id,
      sourceTemplateSnapshotId: seeded.snapshot.id,
      sourceGateDefinitionId: seeded.legacyDefinition.id,
      gateInstanceId: seeded.legacyInstance.id,
      expectedPolicyVersion: 0,
      reason: "升级为 V2 关项策略",
      actorId: adminId,
      auditContext: context("closure-concurrent", seeded.project.id)
    };
    const outcomes = await Promise.allSettled([
      upgradeProjectClosurePolicy({ ...base, idempotencyKey: `closure-concurrent-a-${suffix}` }),
      upgradeProjectClosurePolicy({ ...base, idempotencyKey: `closure-concurrent-b-${suffix}` })
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "CLOSURE_POLICY_VERSION_CONFLICT", status: 409 }
    });
    await expect(
      db.projectClosurePolicyVersion.count({
        where: { projectId: seeded.project.id, status: "ACTIVE" }
      })
    ).resolves.toBe(1);
  });

  it("rolls back the V2 revision, policy, audit, and Outbox when the enclosing transaction aborts", async () => {
    const seeded = await seedLegacyProject(auxiliaryTemplate, "ROLLBACK");
    await expect(
      db.$transaction(async (transaction) => {
        await upgradeProjectClosurePolicy(
          {
            projectId: seeded.project.id,
            sourceTemplateSnapshotId: seeded.snapshot.id,
            sourceGateDefinitionId: seeded.legacyDefinition.id,
            gateInstanceId: seeded.legacyInstance.id,
            expectedPolicyVersion: 0,
            reason: "升级后故意回滚",
            actorId: adminId,
            idempotencyKey: `closure-rollback-${suffix}`,
            auditContext: context("closure-rollback", seeded.project.id)
          },
          transaction
        );
        throw new Error("force closure policy rollback");
      })
    ).rejects.toThrow("force closure policy rollback");
    await expect(
      db.projectGateDefinition.count({ where: { projectId: seeded.project.id, code: "G9" } })
    ).resolves.toBe(1);
    await expect(
      db.projectClosurePolicy.count({ where: { projectId: seeded.project.id } })
    ).resolves.toBe(0);
    await expect(
      db.outboxEvent.count({ where: { eventType: "project.closure-policy.version.activated" } })
    ).resolves.toBe(0);
  });
});
