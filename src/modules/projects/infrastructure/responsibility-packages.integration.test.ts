import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  GET as listPackagesRoute,
  POST as createPackageRoute
} from "@/app/api/projects/[projectId]/responsibility-packages/route";
import {
  GET as readPackageRoute,
  PUT as updatePackageRoute
} from "@/app/api/projects/[projectId]/responsibility-packages/[packageId]/route";
import { POST as commandPackageRoute } from "@/app/api/projects/[projectId]/responsibility-packages/[packageId]/[command]/route";
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
  createResponsibilityPackage,
  transitionResponsibilityPackage,
  updateResponsibilityPackage
} from "@/modules/projects/application/responsibility-package-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `package-admin-${suffix}`,
  owner: `package-owner-${suffix}`,
  outsider: `package-outsider-${suffix}`
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
      const code = `PACKAGE.${componentType}.${suffix}`.toUpperCase();
      const draft = await saveTemplateComponentDraft({
        code,
        componentType,
        name: `${componentType} package test`,
        content: componentDefinition(componentType),
        version: 0,
        reason: "创建责任包测试组件",
        actorId: ids.admin,
        auditContext: context(ids.admin, `component-draft-${componentType}-${suffix}`)
      });
      return (
        await publishTemplateComponent({
          code,
          version: draft.component.version,
          reason: "发布责任包测试组件",
          actorId: ids.admin,
          auditContext: context(ids.admin, `component-publish-${componentType}-${suffix}`)
        })
      ).publishedVersion;
    })
  );
  const code = `PACKAGE.TEMPLATE.${suffix}`.toUpperCase();
  const draft = await saveProjectTemplateDraft({
    code,
    name: "责任包测试模板",
    components: versions.map((version, position) => ({
      componentVersionId: version.id,
      componentType: version.componentType,
      slot: `${version.componentType}.${position}`,
      position
    })),
    version: 0,
    reason: "创建责任包测试模板",
    actorId: ids.admin,
    auditContext: context(ids.admin, `template-draft-${suffix}`)
  });
  return {
    code,
    ...(await publishProjectTemplate({
      code,
      version: draft.template.version,
      reason: "发布责任包测试模板",
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

describeDatabase("APM-014 PostgreSQL responsibility packages", () => {
  let template: Awaited<ReturnType<typeof seedPublishedTemplate>>;
  let projectSequence = 0;

  async function createReadyProject(label: string, internal = false) {
    projectSequence += 1;
    const project = (
      await createProjectFromTemplate({
        code: `P14.${label}.${projectSequence}.${suffix}`.toUpperCase(),
        name: `${label} responsibility package project`,
        departmentId: "engineering",
        templateCode: template.code,
        templateVersion: template.publishedVersion.version,
        templateChecksum: template.publishedVersion.checksum,
        reason: "创建责任包测试项目",
        actorId: ids.admin,
        auditContext: context(ids.admin, `project-${label}-${projectSequence}-${suffix}`)
      })
    ).project;
    const structure = await initializeProjectStructure({
      projectId: project.id,
      projectVersion: project.version,
      projectType: internal ? "INTERNAL_RND" : "CUSTOMER_DELIVERY",
      equipmentShape: internal ? null : "SINGLE_MACHINE",
      deliveryUnits: internal
        ? []
        : [
            {
              code: "MACHINE.01",
              name: "一号单机",
              unitType: "MACHINE",
              parentCode: null,
              position: 0
            }
          ],
      modules: internal
        ? []
        : [{ code: "MODULE.01", name: "设计模块", machineCode: "MACHINE.01", position: 0 }],
      reason: "初始化责任包项目结构",
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
    return { project, structure, ownerMembership };
  }

  function packageBody(
    ready: Awaited<ReturnType<typeof createReadyProject>>,
    code = "MECH.DESIGN"
  ) {
    return {
      code,
      name: "机械设计责任包",
      description: "不包含任何激励或工资字段",
      deliveryUnitId: ready.structure.deliveryUnits[0]?.id ?? null,
      moduleId: ready.structure.modules[0]?.id ?? null,
      ownerMembershipId: ready.ownerMembership.id,
      inputs: [{ code: "REQUIREMENT", description: "冻结的需求输入" }],
      outputs: [{ code: "DRAWING", description: "受控图纸输出" }],
      acceptanceCriteria: [{ code: "REVIEWED", description: "设计评审完成" }],
      valueWeight: 25,
      reason: "创建机械设计责任包"
    };
  }

  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `PACKAGE-ADMIN-${suffix}`,
          name: "责任包管理员",
          departmentId: "engineering"
        },
        {
          id: ids.owner,
          employeeNo: `PACKAGE-OWNER-${suffix}`,
          name: "责任包Owner",
          departmentId: "engineering"
        },
        {
          id: ids.outsider,
          employeeNo: `PACKAGE-OUTSIDER-${suffix}`,
          name: "责任包外部成员",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `package-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        { id: `package-role-owner-${suffix}`, userId: ids.owner, roleId: "role-engineer" },
        { id: `package-role-outsider-${suffix}`, userId: ids.outsider, roleId: "role-engineer" }
      ]
    });
    template = await seedPublishedTemplate();
  });

  it("creates, replays, lists, and reads a package without exposing incentive data", async () => {
    const ready = await createReadyProject("CREATE");
    const url = `http://localhost/api/projects/${ready.project.id}/responsibility-packages`;
    const body = packageBody(ready);
    const first = await createPackageRoute(postRequest(url, body, `create-${suffix}`), {
      params: Promise.resolve({ projectId: ready.project.id })
    });
    const firstBody = (await first.json()) as {
      responsibilityPackage: {
        packageId: string;
        status: string;
        owner: { user: { id: string } };
      };
      resourceVersion: number;
    };
    const replay = await createPackageRoute(postRequest(url, body, `create-${suffix}`), {
      params: Promise.resolve({ projectId: ready.project.id })
    });
    const conflict = await createPackageRoute(
      postRequest(url, { ...body, name: "不同责任包" }, `create-${suffix}`),
      { params: Promise.resolve({ projectId: ready.project.id }) }
    );
    expect(first.status).toBe(201);
    expect(firstBody.responsibilityPackage).toMatchObject({
      status: "OPEN",
      owner: { user: { id: ids.owner } }
    });
    expect(firstBody.resourceVersion).toBe(1);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);
    expect(conflict.status).toBe(409);

    const list = await listPackagesRoute(readRequest(`${url}?limit=10`, ids.owner), {
      params: Promise.resolve({ projectId: ready.project.id })
    });
    const detail = await readPackageRoute(
      readRequest(`${url}/${firstBody.responsibilityPackage.packageId}`, ids.owner),
      {
        params: Promise.resolve({
          projectId: ready.project.id,
          packageId: firstBody.responsibilityPackage.packageId
        })
      }
    );
    const detailText = JSON.stringify(await detail.json());
    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(detailText).not.toMatch(/wage|salary|bonus|settlement/iu);
    expect(
      await listPackagesRoute(readRequest(url, ids.outsider), {
        params: Promise.resolve({ projectId: ready.project.id })
      })
    ).toHaveProperty("status", 403);
    expect(
      await listPackagesRoute(readRequest(url), {
        params: Promise.resolve({ projectId: ready.project.id })
      })
    ).toHaveProperty("status", 401);
    await expect(
      db.responsibilityPackageEvent.count({
        where: { packageId: firstBody.responsibilityPackage.packageId, eventType: "CREATED" }
      })
    ).resolves.toBe(1);
    await expect(
      db.auditLog.count({
        where: {
          objectId: firstBody.responsibilityPackage.packageId,
          action: "RESPONSIBILITY_PACKAGE_CREATED"
        }
      })
    ).resolves.toBe(1);
  });

  it("updates only open packages and rejects stale or cross-project relations", async () => {
    const ready = await createReadyProject("UPDATE");
    const other = await createReadyProject("OTHER");
    const created = await createResponsibilityPackage({
      projectId: ready.project.id,
      ...packageBody(ready),
      actorId: ids.admin,
      auditContext: context(ids.admin, `create-update-${suffix}`, ready.project.id)
    });
    const packageId = created.responsibilityPackage.packageId;
    await expect(
      updateResponsibilityPackage({
        projectId: ready.project.id,
        packageId,
        ...packageBody(other),
        name: "跨项目关系",
        version: 1,
        actorId: ids.admin,
        auditContext: context(ids.admin, `cross-update-${suffix}`, ready.project.id)
      })
    ).rejects.toMatchObject({ code: "RESPONSIBILITY_PACKAGE_OWNER_INVALID", status: 409 });
    await expect(
      updateResponsibilityPackage({
        projectId: ready.project.id,
        packageId,
        ...packageBody(ready),
        version: 2,
        actorId: ids.admin,
        auditContext: context(ids.admin, `stale-update-${suffix}`, ready.project.id)
      })
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });

    const { code: _code, ...updateBody } = packageBody(ready);
    const url = `http://localhost/api/projects/${ready.project.id}/responsibility-packages/${packageId}`;
    const changedBody = { ...updateBody, name: "机械设计责任包V2", version: 1 };
    const changed = await updatePackageRoute(putRequest(url, changedBody, `update-${suffix}`), {
      params: Promise.resolve({ projectId: ready.project.id, packageId })
    });
    const replay = await updatePackageRoute(putRequest(url, changedBody, `update-${suffix}`), {
      params: Promise.resolve({ projectId: ready.project.id, packageId })
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      responsibilityPackage: { name: "机械设计责任包V2", resourceVersion: 2 }
    });
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
  });

  it("submits by Owner and appends accepted and reopened cycles under concurrency", async () => {
    const ready = await createReadyProject("LIFECYCLE");
    const created = await createResponsibilityPackage({
      projectId: ready.project.id,
      ...packageBody(ready),
      actorId: ids.admin,
      auditContext: context(ids.admin, `create-lifecycle-${suffix}`, ready.project.id)
    });
    const packageId = created.responsibilityPackage.packageId;
    const baseUrl = `http://localhost/api/projects/${ready.project.id}/responsibility-packages/${packageId}`;
    const route = (command: string, version: number, key: string, actorId = ids.admin) =>
      commandPackageRoute(
        postRequest(
          `${baseUrl}/${command}`,
          { version, reason: `${command} 责任包` },
          key,
          actorId
        ),
        { params: Promise.resolve({ projectId: ready.project.id, packageId, command }) }
      );

    expect((await route("submit", 1, `outsider-submit-${suffix}`, ids.outsider)).status).toBe(403);
    const submitted = await route("submit", 1, `submit-1-${suffix}`, ids.owner);
    const submittedBody = await submitted.json();
    const replay = await route("submit", 1, `submit-1-${suffix}`, ids.owner);
    expect(submitted.status).toBe(200);
    expect(submittedBody).toMatchObject({
      responsibilityPackage: { status: "ACCEPTANCE_PENDING", acceptanceCycle: 1 },
      resourceVersion: 2
    });
    expect(replay.headers.get("idempotency-replayed")).toBe("true");

    const accepted = await route("accept", 2, `accept-1-${suffix}`);
    expect(await accepted.json()).toMatchObject({
      responsibilityPackage: { status: "ACCEPTED", acceptanceCycle: 1 },
      resourceVersion: 3
    });
    await expect(
      updateResponsibilityPackage({
        projectId: ready.project.id,
        packageId,
        ...packageBody(ready),
        version: 3,
        actorId: ids.admin,
        auditContext: context(ids.admin, `accepted-update-${suffix}`, ready.project.id)
      })
    ).rejects.toMatchObject({ code: "RESPONSIBILITY_PACKAGE_NOT_EDITABLE", status: 409 });

    expect((await route("reopen", 3, `reopen-${suffix}`)).status).toBe(200);
    expect((await route("submit", 4, `submit-2-${suffix}`, ids.owner)).status).toBe(200);
    const outcomes = await Promise.all([
      route("accept", 5, `accept-2a-${suffix}`),
      route("accept", 5, `accept-2b-${suffix}`)
    ]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual([200, 409]);
    const events = await db.responsibilityPackageEvent.findMany({
      where: { packageId },
      orderBy: { sequence: "asc" }
    });
    expect(events.map(({ eventType }) => eventType)).toEqual([
      "CREATED",
      "ACCEPTANCE_SUBMITTED",
      "ACCEPTED",
      "REOPENED",
      "ACCEPTANCE_SUBMITTED",
      "ACCEPTED"
    ]);
    expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.at(-1)).toMatchObject({ acceptanceCycle: 2, resourceVersion: 6 });
  });

  it("closes without incentives and rolls failed writes, audits, and Outbox back together", async () => {
    const ready = await createReadyProject("CLOSE", true);
    const body = packageBody(ready, "RND.REVIEW");
    await expect(
      createResponsibilityPackage({
        projectId: ready.project.id,
        ...body,
        actorId: `missing-package-actor-${suffix}`,
        auditContext: context(
          `missing-package-actor-${suffix}`,
          `rollback-package-${suffix}`,
          ready.project.id
        )
      })
    ).rejects.toMatchObject({ code: "RESPONSIBILITY_PACKAGE_RELATION_INVALID", status: 409 });
    await expect(
      db.responsibilityPackage.count({ where: { projectId: ready.project.id } })
    ).resolves.toBe(0);
    await expect(
      db.auditLog.count({
        where: { projectId: ready.project.id, action: "RESPONSIBILITY_PACKAGE_CREATED" }
      })
    ).resolves.toBe(0);

    const created = await createResponsibilityPackage({
      projectId: ready.project.id,
      ...body,
      actorId: ids.admin,
      auditContext: context(ids.admin, `create-close-${suffix}`, ready.project.id)
    });
    const closed = await transitionResponsibilityPackage({
      projectId: ready.project.id,
      packageId: created.responsibilityPackage.packageId,
      transition: "CLOSED",
      version: 1,
      reason: "关闭研发责任包",
      actorId: ids.admin,
      auditContext: context(ids.admin, `close-${suffix}`, ready.project.id)
    });
    expect(closed).toMatchObject({
      responsibilityPackage: { status: "CLOSED", allowedActions: [] },
      resourceVersion: 2
    });
    await expect(
      transitionResponsibilityPackage({
        projectId: ready.project.id,
        packageId: created.responsibilityPackage.packageId,
        transition: "ACCEPTANCE_SUBMITTED",
        version: 2,
        reason: "关闭后不能提交",
        actorId: ids.admin,
        auditContext: context(ids.admin, `closed-submit-${suffix}`, ready.project.id)
      })
    ).rejects.toMatchObject({ code: "RESPONSIBILITY_PACKAGE_TRANSITION_INVALID", status: 409 });
  });

  it("enforces same-project Owner and immutable durable facts in PostgreSQL", async () => {
    const ready = await createReadyProject("CONSTRAINT");
    const other = await createReadyProject("CONSTRAINT-OTHER");
    const body = packageBody(ready);
    await expect(
      db.responsibilityPackage.create({
        data: {
          projectId: ready.project.id,
          deliveryUnitId: body.deliveryUnitId,
          moduleId: body.moduleId,
          code: `BAD.OWNER.${suffix}`.toUpperCase(),
          name: body.name,
          description: body.description,
          ownerMembershipId: other.ownerMembership.id,
          inputsJson: body.inputs,
          outputsJson: body.outputs,
          acceptanceCriteriaJson: body.acceptanceCriteria,
          valueWeight: body.valueWeight,
          createdById: ids.admin,
          updatedById: ids.admin
        }
      })
    ).rejects.toThrow(/active member of the same project/u);

    const created = await createResponsibilityPackage({
      projectId: ready.project.id,
      ...body,
      actorId: ids.admin,
      auditContext: context(ids.admin, `create-constraint-${suffix}`, ready.project.id)
    });
    const packageId = created.responsibilityPackage.packageId;
    const event = await db.responsibilityPackageEvent.findFirstOrThrow({ where: { packageId } });
    await expect(
      db.responsibilityPackageEvent.update({
        where: { id: event.id },
        data: { reason: "不得改写" }
      })
    ).rejects.toThrow(/durable and cannot be removed/u);
    await expect(db.responsibilityPackageEvent.delete({ where: { id: event.id } })).rejects.toThrow(
      /durable and cannot be removed/u
    );
    await expect(db.responsibilityPackage.delete({ where: { id: packageId } })).rejects.toThrow(
      /durable and cannot be removed/u
    );
    await expect(
      db.$executeRawUnsafe(
        'TRUNCATE TABLE "responsibility_package_events", "responsibility_packages"'
      )
    ).rejects.toThrow(/durable and cannot be removed|cannot truncate a table referenced/iu);
  });
});
