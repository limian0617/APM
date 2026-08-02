import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  GET as readStructureRoute,
  POST as initializeStructureRoute
} from "@/app/api/projects/[projectId]/structure/route";
import { POST as changeDeliveryUnitStatusRoute } from "@/app/api/projects/[projectId]/delivery-units/[deliveryUnitId]/status/route";
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
  initializeProjectStructure,
  setDeliveryUnitEnabled
} from "@/modules/projects/application/project-structure";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `structure-admin-${suffix}`,
  engineer: `structure-engineer-${suffix}`,
  outsider: `structure-outsider-${suffix}`
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
  }
}

async function seedPublishedTemplate() {
  const versions = await Promise.all(
    (["STAGE", "GATE", "ROLE", "WBS"] as const).map(async (componentType) => {
      const code = `STRUCTURE.${componentType}.${suffix}`.toUpperCase();
      const draft = await saveTemplateComponentDraft({
        code,
        componentType,
        name: `${componentType} structure test`,
        content: componentDefinition(componentType),
        version: 0,
        reason: "创建项目结构测试组件",
        actorId: ids.admin,
        auditContext: context(ids.admin, `component-draft-${componentType}-${suffix}`)
      });
      return (
        await publishTemplateComponent({
          code,
          version: draft.component.version,
          reason: "发布项目结构测试组件",
          actorId: ids.admin,
          auditContext: context(ids.admin, `component-publish-${componentType}-${suffix}`)
        })
      ).publishedVersion;
    })
  );
  const code = `STRUCTURE.TEMPLATE.${suffix}`.toUpperCase();
  const draft = await saveProjectTemplateDraft({
    code,
    name: "项目结构测试模板",
    components: versions.map((version, position) => ({
      componentVersionId: version.id,
      componentType: version.componentType,
      slot: `${version.componentType}.${position}`,
      position
    })),
    version: 0,
    reason: "创建项目结构测试模板",
    actorId: ids.admin,
    auditContext: context(ids.admin, `template-draft-${suffix}`)
  });
  const published = await publishProjectTemplate({
    code,
    version: draft.template.version,
    reason: "发布项目结构测试模板",
    actorId: ids.admin,
    auditContext: context(ids.admin, `template-publish-${suffix}`)
  });
  return { code, ...published };
}

function singleMachineBody(projectVersion = 1) {
  return {
    projectVersion,
    projectType: "CUSTOMER_DELIVERY" as const,
    equipmentShape: "SINGLE_MACHINE" as const,
    deliveryUnits: [
      {
        code: "MACHINE.01",
        name: "一号单机",
        unitType: "MACHINE" as const,
        parentCode: null,
        position: 0
      }
    ],
    modules: [
      {
        code: "MODULE.01",
        name: "上料模块",
        machineCode: "MACHINE.01",
        position: 0
      }
    ],
    reason: "初始化单机结构"
  };
}

function lineBody(projectVersion = 1) {
  return {
    projectVersion,
    projectType: "CUSTOMER_DELIVERY" as const,
    equipmentShape: "LINE" as const,
    deliveryUnits: [
      { code: "LINE.01", name: "总装线", unitType: "LINE" as const, parentCode: null, position: 0 },
      {
        code: "AREA.01",
        name: "装配工段",
        unitType: "AREA" as const,
        parentCode: "LINE.01",
        position: 0
      },
      {
        code: "MACHINE.01",
        name: "一号单机",
        unitType: "MACHINE" as const,
        parentCode: "AREA.01",
        position: 0
      },
      {
        code: "MACHINE.02",
        name: "二号单机",
        unitType: "MACHINE" as const,
        parentCode: "LINE.01",
        position: 1
      }
    ],
    modules: [
      { code: "MODULE.01", name: "上料模块", machineCode: "MACHINE.01", position: 0 },
      { code: "MODULE.02", name: "检测模块", machineCode: "MACHINE.02", position: 0 }
    ],
    reason: "初始化整线结构"
  };
}

function commandRequest(url: string, body: unknown, key: string, actorId = ids.admin) {
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

function readRequest(url: string, actorId?: string) {
  return new Request(url, {
    headers: actorId ? { "x-apm-user-id": actorId } : undefined
  });
}

describeDatabase("APM-012 PostgreSQL project structure", () => {
  let template: Awaited<ReturnType<typeof seedPublishedTemplate>>;
  let projectSequence = 0;

  async function createProject(label: string) {
    projectSequence += 1;
    return (
      await createProjectFromTemplate({
        code: `S12.${label}.${projectSequence}.${suffix}`.toUpperCase(),
        name: `${label} project`,
        departmentId: "engineering",
        templateCode: template.code,
        templateVersion: template.publishedVersion.version,
        templateChecksum: template.publishedVersion.checksum,
        reason: "创建项目结构测试项目",
        actorId: ids.admin,
        auditContext: context(ids.admin, `project-${label}-${projectSequence}-${suffix}`)
      })
    ).project;
  }

  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `STRUCTURE-ADMIN-${suffix}`,
          name: "项目结构管理员",
          departmentId: "engineering"
        },
        {
          id: ids.engineer,
          employeeNo: `STRUCTURE-ENGINEER-${suffix}`,
          name: "项目结构只读成员",
          departmentId: "engineering"
        },
        {
          id: ids.outsider,
          employeeNo: `STRUCTURE-OUTSIDER-${suffix}`,
          name: "非项目成员",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `structure-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        { id: `structure-role-engineer-${suffix}`, userId: ids.engineer, roleId: "role-engineer" },
        { id: `structure-role-outsider-${suffix}`, userId: ids.outsider, roleId: "role-engineer" }
      ]
    });
    template = await seedPublishedTemplate();
  });

  it("initializes one simplified machine atomically and replays the exact API result", async () => {
    const project = await createProject("SINGLE");
    await db.projectMember.create({
      data: {
        projectId: project.id,
        userId: ids.engineer,
        projectRole: "VIEWER",
        departmentId: "engineering",
        assignedById: ids.admin
      }
    });
    const url = `http://localhost/api/projects/${project.id}/structure`;
    const body = singleMachineBody(project.version);
    const first = await initializeStructureRoute(commandRequest(url, body, `single-${suffix}`), {
      params: Promise.resolve({ projectId: project.id })
    });
    const firstBody = (await first.json()) as {
      project: { projectType: string; equipmentShape: string; structureStatus: string };
      deliveryUnits: Array<{ id: string; code: string }>;
      modules: Array<{ code: string }>;
      auditId: string;
      outboxEventId: string;
      resourceVersion: number;
    };
    const replay = await initializeStructureRoute(commandRequest(url, body, `single-${suffix}`), {
      params: Promise.resolve({ projectId: project.id })
    });

    expect(first.status).toBe(201);
    expect(firstBody.project).toMatchObject({
      projectType: "CUSTOMER_DELIVERY",
      equipmentShape: "SINGLE_MACHINE",
      structureStatus: "READY"
    });
    expect(firstBody.deliveryUnits.map(({ code }) => code)).toEqual(["MACHINE.01"]);
    expect(firstBody.modules.map(({ code }) => code)).toEqual(["MODULE.01"]);
    expect(firstBody.resourceVersion).toBe(project.version + 1);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);
    await expect(
      db.auditLog.count({
        where: { projectId: project.id, action: "PROJECT_STRUCTURE_INITIALIZED" }
      })
    ).resolves.toBe(1);
    await expect(
      db.outboxEvent.count({
        where: { aggregateId: project.id, eventType: "project.structure.initialized" }
      })
    ).resolves.toBe(1);

    const read = await readStructureRoute(readRequest(url, ids.engineer), {
      params: Promise.resolve({ projectId: project.id })
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      project: {
        id: project.id,
        projectType: "CUSTOMER_DELIVERY",
        deliveryUnits: [{ code: "MACHINE.01" }],
        projectModules: [{ code: "MODULE.01" }]
      }
    });

    const forbiddenWrite = await initializeStructureRoute(
      commandRequest(url, body, `forbidden-member-${suffix}`, ids.engineer),
      { params: Promise.resolve({ projectId: project.id }) }
    );
    const unrelatedRead = await readStructureRoute(readRequest(url, ids.outsider), {
      params: Promise.resolve({ projectId: project.id })
    });
    const unauthenticatedRead = await readStructureRoute(readRequest(url), {
      params: Promise.resolve({ projectId: project.id })
    });
    expect(forbiddenWrite.status).toBe(403);
    expect(unrelatedRead.status).toBe(403);
    expect(unauthenticatedRead.status).toBe(401);
  });

  it("keeps line machines independently enabled and hides cross-project unit IDs", async () => {
    const project = await createProject("LINE");
    const url = `http://localhost/api/projects/${project.id}/structure`;
    const initialized = await initializeStructureRoute(
      commandRequest(url, lineBody(project.version), `line-${suffix}`),
      { params: Promise.resolve({ projectId: project.id }) }
    );
    expect(initialized.status).toBe(201);
    const structure = (await initialized.json()) as {
      deliveryUnits: Array<{ id: string; code: string; status: string; version: number }>;
    };
    const firstMachine = structure.deliveryUnits.find(({ code }) => code === "MACHINE.01")!;
    const secondMachine = structure.deliveryUnits.find(({ code }) => code === "MACHINE.02")!;
    const statusUrl = `http://localhost/api/projects/${project.id}/delivery-units/${firstMachine.id}/status`;
    const statusBody = {
      version: firstMachine.version,
      enabled: false,
      reason: "单独停用一号单机"
    };
    const disabled = await changeDeliveryUnitStatusRoute(
      commandRequest(statusUrl, statusBody, `disable-machine-${suffix}`),
      { params: Promise.resolve({ projectId: project.id, deliveryUnitId: firstMachine.id }) }
    );
    const replay = await changeDeliveryUnitStatusRoute(
      commandRequest(statusUrl, statusBody, `disable-machine-${suffix}`),
      { params: Promise.resolve({ projectId: project.id, deliveryUnitId: firstMachine.id }) }
    );

    expect(disabled.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.json()).toEqual(await disabled.json());
    await expect(
      db.deliveryUnit.findUniqueOrThrow({ where: { id: firstMachine.id } })
    ).resolves.toMatchObject({
      status: "DISABLED",
      version: firstMachine.version + 1
    });
    await expect(
      db.deliveryUnit.findUniqueOrThrow({ where: { id: secondMachine.id } })
    ).resolves.toMatchObject({
      status: "ACTIVE",
      version: secondMachine.version
    });

    const otherProject = await createProject("IDOR");
    await initializeProjectStructure({
      projectId: otherProject.id,
      ...singleMachineBody(otherProject.version),
      actorId: ids.admin,
      auditContext: context(ids.admin, `idor-init-${suffix}`, otherProject.id)
    });
    const hidden = await changeDeliveryUnitStatusRoute(
      commandRequest(
        `http://localhost/api/projects/${otherProject.id}/delivery-units/${secondMachine.id}/status`,
        { version: secondMachine.version, enabled: false, reason: "跨项目对象不应可见" },
        `idor-${suffix}`
      ),
      { params: Promise.resolve({ projectId: otherProject.id, deliveryUnitId: secondMachine.id }) }
    );
    expect(hidden.status).toBe(404);
  });

  it("supports internal R&D and rolls back stale, concurrent, and failed initialization", async () => {
    const internalProject = await createProject("RND");
    const internal = await initializeProjectStructure({
      projectId: internalProject.id,
      projectVersion: internalProject.version,
      projectType: "INTERNAL_RND",
      equipmentShape: null,
      deliveryUnits: [],
      modules: [],
      reason: "初始化内部研发项目",
      actorId: ids.admin,
      auditContext: context(ids.admin, `rnd-${suffix}`, internalProject.id)
    });
    expect(internal).toMatchObject({
      project: { projectType: "INTERNAL_RND", equipmentShape: null, structureStatus: "READY" },
      deliveryUnits: [],
      modules: []
    });

    const concurrentProject = await createProject("CONCURRENT");
    const concurrentUrl = `http://localhost/api/projects/${concurrentProject.id}/structure`;
    const outcomes = await Promise.all([
      initializeStructureRoute(
        commandRequest(
          concurrentUrl,
          singleMachineBody(concurrentProject.version),
          `concurrent-a-${suffix}`
        ),
        { params: Promise.resolve({ projectId: concurrentProject.id }) }
      ),
      initializeStructureRoute(
        commandRequest(
          concurrentUrl,
          singleMachineBody(concurrentProject.version),
          `concurrent-b-${suffix}`
        ),
        { params: Promise.resolve({ projectId: concurrentProject.id }) }
      )
    ]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual([201, 409]);
    await expect(
      db.deliveryUnit.count({ where: { projectId: concurrentProject.id } })
    ).resolves.toBe(1);
    await expect(
      db.auditLog.count({
        where: { projectId: concurrentProject.id, action: "PROJECT_STRUCTURE_INITIALIZED" }
      })
    ).resolves.toBe(1);

    const staleProject = await createProject("STALE");
    await expect(
      initializeProjectStructure({
        projectId: staleProject.id,
        ...singleMachineBody(staleProject.version + 1),
        actorId: ids.admin,
        auditContext: context(ids.admin, `stale-${suffix}`, staleProject.id)
      })
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
    await expect(db.deliveryUnit.count({ where: { projectId: staleProject.id } })).resolves.toBe(0);

    const rollbackProject = await createProject("ROLLBACK");
    await expect(
      initializeProjectStructure({
        projectId: rollbackProject.id,
        ...singleMachineBody(rollbackProject.version),
        actorId: `missing-actor-${suffix}`,
        auditContext: context(`missing-actor-${suffix}`, `rollback-${suffix}`, rollbackProject.id)
      })
    ).rejects.toMatchObject({ code: "PROJECT_STRUCTURE_RELATION_INVALID", status: 409 });
    await expect(
      db.project.findUniqueOrThrow({ where: { id: rollbackProject.id } })
    ).resolves.toMatchObject({
      projectType: "LEGACY",
      equipmentShape: null,
      structureStatus: "UNCONFIGURED",
      version: rollbackProject.version
    });
    await expect(db.deliveryUnit.count({ where: { projectId: rollbackProject.id } })).resolves.toBe(
      0
    );
    await expect(
      db.auditLog.count({
        where: { projectId: rollbackProject.id, action: "PROJECT_STRUCTURE_INITIALIZED" }
      })
    ).resolves.toBe(0);
    await expect(
      db.outboxEvent.count({
        where: { aggregateId: rollbackProject.id, eventType: "project.structure.initialized" }
      })
    ).resolves.toBe(0);
  });

  it("enforces optimistic unit status changes and rollback without success facts", async () => {
    const project = await createProject("STATUS");
    const initialized = await initializeProjectStructure({
      projectId: project.id,
      ...singleMachineBody(project.version),
      actorId: ids.admin,
      auditContext: context(ids.admin, `status-init-${suffix}`, project.id)
    });
    const unit = initialized.deliveryUnits[0]!;

    await expect(
      setDeliveryUnitEnabled({
        projectId: project.id,
        deliveryUnitId: unit.id,
        version: unit.version + 1,
        enabled: false,
        reason: "过期版本停用",
        actorId: ids.admin,
        auditContext: context(ids.admin, `status-stale-${suffix}`, project.id)
      })
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
    await expect(
      db.deliveryUnit.findUniqueOrThrow({ where: { id: unit.id } })
    ).resolves.toMatchObject({
      status: "ACTIVE",
      version: unit.version
    });
    await expect(
      db.auditLog.count({
        where: { projectId: project.id, action: "DELIVERY_UNIT_STATUS_CHANGED" }
      })
    ).resolves.toBe(0);
    await expect(
      db.outboxEvent.count({
        where: { aggregateId: unit.id, eventType: "project.delivery-unit.status-changed" }
      })
    ).resolves.toBe(0);
  });

  it("rejects invalid SQL relationships, stable identity changes, and physical removal", async () => {
    const firstProject = await createProject("DBA");
    const first = await initializeProjectStructure({
      projectId: firstProject.id,
      ...lineBody(firstProject.version),
      actorId: ids.admin,
      auditContext: context(ids.admin, `db-a-${suffix}`, firstProject.id)
    });
    const secondProject = await createProject("DBB");
    const second = await initializeProjectStructure({
      projectId: secondProject.id,
      ...lineBody(secondProject.version),
      actorId: ids.admin,
      auditContext: context(ids.admin, `db-b-${suffix}`, secondProject.id)
    });
    const firstLine = first.deliveryUnits.find(({ code }) => code === "LINE.01")!;
    const firstMachine = first.deliveryUnits.find(({ code }) => code === "MACHINE.01")!;
    const secondMachine = second.deliveryUnits.find(({ code }) => code === "MACHINE.01")!;

    await expect(
      db.deliveryUnit.create({
        data: {
          projectId: secondProject.id,
          parentId: firstLine.id,
          unitType: "MACHINE",
          code: `CROSS.${suffix}`.toUpperCase(),
          name: "跨项目单机",
          position: 99,
          createdById: ids.admin,
          updatedById: ids.admin
        }
      })
    ).rejects.toThrow(/same project/u);
    await expect(
      db.deliveryUnit.create({
        data: {
          projectId: firstProject.id,
          parentId: null,
          unitType: "AREA",
          code: `BADAREA.${suffix}`.toUpperCase(),
          name: "非法根工段",
          position: 99,
          createdById: ids.admin,
          updatedById: ids.admin
        }
      })
    ).rejects.toThrow(/area units/u);
    await expect(
      db.projectModule.create({
        data: {
          projectId: secondProject.id,
          deliveryUnitId: firstMachine.id,
          code: `CROSSMODULE.${suffix}`.toUpperCase(),
          name: "跨项目模块",
          position: 99,
          createdById: ids.admin,
          updatedById: ids.admin
        }
      })
    ).rejects.toThrow(/same ready project/u);
    await expect(
      db.deliveryUnit.update({
        where: { id: secondMachine.id },
        data: { code: `MUTATED.${suffix}`.toUpperCase() }
      })
    ).rejects.toThrow(/stable identity is immutable/u);
    await expect(
      db.project.update({
        where: { id: firstProject.id },
        data: { equipmentShape: "SINGLE_MACHINE" }
      })
    ).rejects.toThrow(/classification is immutable/u);
    const legacyProject = await db.project.create({
      data: {
        code: `S12.LEGACY.${suffix}`.toUpperCase(),
        name: "未初始化模板的存量项目",
        departmentId: "engineering",
        createdById: ids.admin
      }
    });
    await expect(
      db.project.update({
        where: { id: legacyProject.id },
        data: { projectType: "INTERNAL_RND", structureStatus: "READY" }
      })
    ).rejects.toThrow();
    await expect(db.projectModule.delete({ where: { id: first.modules[0]!.id } })).rejects.toThrow(
      /disabled instead of removed/u
    );
    await expect(db.deliveryUnit.delete({ where: { id: firstMachine.id } })).rejects.toThrow(
      /disabled instead of removed/u
    );
    await expect(
      db.$executeRawUnsafe('TRUNCATE TABLE "project_modules", "delivery_units"')
    ).rejects.toThrow(/disabled instead of removed|cannot truncate a table referenced/iu);
  });
});
