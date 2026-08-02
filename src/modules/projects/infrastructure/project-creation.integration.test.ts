import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { POST as createProjectRoute } from "@/app/api/projects/route";
import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  publishProjectTemplate,
  publishTemplateComponent,
  saveProjectTemplateDraft,
  saveTemplateComponentDraft,
  setProjectTemplateEnabled
} from "@/modules/configuration/application/template-service";
import { createProjectFromTemplate } from "@/modules/projects/application/create-project";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `project-create-admin-${suffix}`,
  engineer: `project-create-engineer-${suffix}`
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
    departmentId: null,
    operationId
  };
}

function definition(type: "STAGE" | "GATE" | "ROLE" | "WBS") {
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

async function seedPublishedTemplate(label: string) {
  const componentVersions = await Promise.all(
    (["STAGE", "GATE", "ROLE", "WBS"] as const).map(async (componentType) => {
      const code = `PROJECT.${label}.${componentType}.${suffix}`.toUpperCase();
      const draft = await saveTemplateComponentDraft({
        code,
        componentType,
        name: `${componentType} ${label}`,
        content: definition(componentType),
        version: 0,
        reason: "创建项目测试组件",
        actorId: ids.admin,
        auditContext: context(ids.admin, `component-draft-${label}-${componentType}-${suffix}`)
      });
      return (
        await publishTemplateComponent({
          code,
          version: draft.component.version,
          reason: "发布项目测试组件",
          actorId: ids.admin,
          auditContext: context(ids.admin, `component-publish-${label}-${componentType}-${suffix}`)
        })
      ).publishedVersion;
    })
  );
  const code = `PROJECT.TEMPLATE.${label}.${suffix}`.toUpperCase();
  const components = componentVersions.map((component, position) => ({
    componentVersionId: component.id,
    componentType: component.componentType,
    slot: `${component.componentType}.${position}`,
    position
  }));
  const draft = await saveProjectTemplateDraft({
    code,
    name: `${label} template`,
    components,
    version: 0,
    reason: "创建项目测试模板",
    actorId: ids.admin,
    auditContext: context(ids.admin, `template-draft-${label}-${suffix}`)
  });
  const published = await publishProjectTemplate({
    code,
    version: draft.template.version,
    reason: "发布项目测试模板",
    actorId: ids.admin,
    auditContext: context(ids.admin, `template-publish-${label}-${suffix}`)
  });
  return { code, components, ...published };
}

function projectBody(
  template: Awaited<ReturnType<typeof seedPublishedTemplate>>,
  code: string,
  name = "Template project"
) {
  return {
    code,
    name,
    departmentId: "engineering",
    templateCode: template.code,
    templateVersion: template.publishedVersion.version,
    templateChecksum: template.publishedVersion.checksum,
    reason: "从已发布模板创建项目"
  };
}

function request(body: unknown, key: string, userId?: string) {
  return new Request("http://localhost/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(userId ? { "x-apm-user-id": userId } : {}),
      "idempotency-key": key,
      "x-request-id": `request-${key}`
    },
    body: JSON.stringify(body)
  });
}

describeDatabase("APM-011 PostgreSQL project creation", () => {
  let baseTemplate: Awaited<ReturnType<typeof seedPublishedTemplate>>;

  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `PROJECT-CREATE-ADMIN-${suffix}`,
          name: "项目创建管理员",
          departmentId: "engineering"
        },
        {
          id: ids.engineer,
          employeeNo: `PROJECT-CREATE-ENGINEER-${suffix}`,
          name: "无创建权限工程师",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `project-create-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        {
          id: `project-create-role-engineer-${suffix}`,
          userId: ids.engineer,
          roleId: "role-engineer"
        }
      ]
    });
    baseTemplate = await seedPublishedTemplate("BASE");
  });

  it("creates independent deep snapshots and replays the exact API result", async () => {
    const firstCode = `PRJ-API-${suffix}`.toUpperCase();
    const body = projectBody(baseTemplate, firstCode);
    const first = await createProjectRoute(request(body, `create-project-${suffix}`, ids.admin));
    const firstBody = (await first.json()) as {
      project: { id: string };
      snapshot: { id: string; checksum: string; referenceCount: number };
    };
    const replay = await createProjectRoute(request(body, `create-project-${suffix}`, ids.admin));
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);
    const conflict = await createProjectRoute(
      request({ ...body, name: "Different" }, `create-project-${suffix}`, ids.admin)
    );
    expect(conflict.status).toBe(409);

    const second = await createProjectFromTemplate({
      ...projectBody(baseTemplate, `PRJ-SECOND-${suffix}`.toUpperCase()),
      actorId: ids.admin,
      auditContext: context(ids.admin, `second-project-${suffix}`)
    });
    const snapshots = await db.projectTemplateSnapshot.findMany({
      where: { projectId: { in: [firstBody.project.id, second.project.id] } },
      include: { components: { orderBy: { position: "asc" } } },
      orderBy: { projectId: "asc" }
    });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]!.id).not.toBe(snapshots[1]!.id);
    expect(
      snapshots.map(({ components }) =>
        components.map(({ componentType, slot, contentJson }) => ({
          componentType,
          slot,
          contentJson
        }))
      )
    ).toEqual([
      snapshots[0]!.components.map(({ componentType, slot, contentJson }) => ({
        componentType,
        slot,
        contentJson
      })),
      snapshots[0]!.components.map(({ componentType, slot, contentJson }) => ({
        componentType,
        slot,
        contentJson
      }))
    ]);
    await expect(
      db.projectMember.count({
        where: { projectId: { in: [firstBody.project.id, second.project.id] }, userId: ids.admin }
      })
    ).resolves.toBe(2);
    await expect(
      db.auditLog.count({ where: { action: "PROJECT_CREATED", actorId: ids.admin } })
    ).resolves.toBeGreaterThanOrEqual(2);
    await expect(
      db.outboxEvent.count({ where: { eventType: "project.created" } })
    ).resolves.toBeGreaterThanOrEqual(2);
  });

  it("rejects unauthenticated, unauthorized, missing, unpublished, and stale template inputs", async () => {
    const body = projectBody(baseTemplate, `PRJ-DENIED-${suffix}`.toUpperCase());
    expect((await createProjectRoute(request(body, `unauthenticated-${suffix}`))).status).toBe(401);
    expect(
      (await createProjectRoute(request(body, `forbidden-${suffix}`, ids.engineer))).status
    ).toBe(403);
    await expect(
      createProjectFromTemplate({
        ...body,
        code: `PRJ-MISSING-${suffix}`.toUpperCase(),
        templateCode: `MISSING.${suffix}`.toUpperCase(),
        actorId: ids.admin,
        auditContext: context(ids.admin, `missing-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND", status: 404 });
    await expect(
      createProjectFromTemplate({
        ...body,
        code: `PRJ-VERSION-${suffix}`.toUpperCase(),
        templateVersion: 999,
        actorId: ids.admin,
        auditContext: context(ids.admin, `version-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "TEMPLATE_VERSION_NOT_FOUND", status: 404 });

    const beforeProjects = await db.project.count();
    const beforeAudits = await db.auditLog.count({ where: { action: "PROJECT_CREATED" } });
    const beforeEvents = await db.outboxEvent.count({ where: { eventType: "project.created" } });
    await expect(
      createProjectFromTemplate({
        ...body,
        code: `PRJ-CHECKSUM-${suffix}`.toUpperCase(),
        templateChecksum: "0".repeat(64),
        actorId: ids.admin,
        auditContext: context(ids.admin, `checksum-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "TEMPLATE_CHECKSUM_MISMATCH", status: 409 });
    await expect(db.project.count()).resolves.toBe(beforeProjects);
    await expect(db.auditLog.count({ where: { action: "PROJECT_CREATED" } })).resolves.toBe(
      beforeAudits
    );
    await expect(db.outboxEvent.count({ where: { eventType: "project.created" } })).resolves.toBe(
      beforeEvents
    );

    const draftCode = `PROJECT.TEMPLATE.DRAFT.${suffix}`.toUpperCase();
    await saveProjectTemplateDraft({
      code: draftCode,
      name: "Unpublished",
      components: baseTemplate.components,
      version: 0,
      reason: "仅保存草稿",
      actorId: ids.admin,
      auditContext: context(ids.admin, `unpublished-draft-${suffix}`)
    });
    await expect(
      createProjectFromTemplate({
        ...body,
        code: `PRJ-UNPUBLISHED-${suffix}`.toUpperCase(),
        templateCode: draftCode,
        actorId: ids.admin,
        auditContext: context(ids.admin, `unpublished-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_PUBLISHED", status: 409 });
  });

  it("does not change an existing snapshot after template republish and disable", async () => {
    const template = await seedPublishedTemplate("DRIFT");
    const created = await createProjectFromTemplate({
      ...projectBody(template, `PRJ-DRIFT-${suffix}`.toUpperCase()),
      actorId: ids.admin,
      auditContext: context(ids.admin, `drift-project-${suffix}`)
    });
    const before = await db.projectTemplateSnapshot.findUniqueOrThrow({
      where: { projectId: created.project.id },
      include: { components: { orderBy: { position: "asc" } } }
    });
    const nextDraft = await saveProjectTemplateDraft({
      code: template.code,
      name: "Changed template name",
      components: template.components,
      version: template.template.version,
      reason: "发布新模板版本",
      actorId: ids.admin,
      auditContext: context(ids.admin, `drift-draft-${suffix}`)
    });
    const next = await publishProjectTemplate({
      code: template.code,
      version: nextDraft.template.version,
      reason: "发布版本二",
      actorId: ids.admin,
      auditContext: context(ids.admin, `drift-publish-${suffix}`)
    });
    await setProjectTemplateEnabled({
      code: template.code,
      version: next.template.version,
      enabled: false,
      reason: "停用模板",
      actorId: ids.admin,
      auditContext: context(ids.admin, `drift-disable-${suffix}`)
    });
    await expect(
      db.projectTemplateSnapshot.findUniqueOrThrow({
        where: { projectId: created.project.id },
        include: { components: { orderBy: { position: "asc" } } }
      })
    ).resolves.toEqual(before);
    await expect(
      createProjectFromTemplate({
        ...projectBody(template, `PRJ-DISABLED-${suffix}`.toUpperCase()),
        actorId: ids.admin,
        auditContext: context(ids.admin, `disabled-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "TEMPLATE_DISABLED", status: 409 });
  });

  it("enforces unique project codes under retries and concurrency without partial facts", async () => {
    const code = `PRJ-CONCURRENT-${suffix}`.toUpperCase();
    const body = projectBody(baseTemplate, code);
    const responses = await Promise.all([
      createProjectRoute(request(body, `concurrent-a-${suffix}`, ids.admin)),
      createProjectRoute(request(body, `concurrent-b-${suffix}`, ids.admin))
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    await expect(db.project.count({ where: { code } })).resolves.toBe(1);
    const project = await db.project.findUniqueOrThrow({ where: { code } });
    await expect(
      db.projectTemplateSnapshot.count({ where: { projectId: project.id } })
    ).resolves.toBe(1);
    await expect(db.projectMember.count({ where: { projectId: project.id } })).resolves.toBe(1);

    const beforeAudits = await db.auditLog.count({ where: { action: "PROJECT_CREATED" } });
    const beforeEvents = await db.outboxEvent.count({ where: { eventType: "project.created" } });
    await expect(
      createProjectFromTemplate({
        ...body,
        actorId: ids.admin,
        auditContext: context(ids.admin, `duplicate-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "PROJECT_CODE_CONFLICT", status: 409 });
    await expect(db.auditLog.count({ where: { action: "PROJECT_CREATED" } })).resolves.toBe(
      beforeAudits
    );
    await expect(db.outboxEvent.count({ where: { eventType: "project.created" } })).resolves.toBe(
      beforeEvents
    );
  });

  it("makes project-owned snapshots immutable through ORM and direct SQL", async () => {
    const created = await createProjectFromTemplate({
      ...projectBody(baseTemplate, `PRJ-IMMUTABLE-${suffix}`.toUpperCase()),
      actorId: ids.admin,
      auditContext: context(ids.admin, `immutable-${suffix}`)
    });
    const snapshot = await db.projectTemplateSnapshot.findUniqueOrThrow({
      where: { projectId: created.project.id },
      include: { components: true }
    });
    await expect(
      db.projectTemplateSnapshot.update({
        where: { id: snapshot.id },
        data: { templateName: "mutated" }
      })
    ).rejects.toThrow(/immutable/u);
    await expect(
      db.projectTemplateSnapshotComponent.delete({ where: { id: snapshot.components[0]!.id } })
    ).rejects.toThrow(/immutable/u);
    await expect(
      db.$executeRawUnsafe(
        'TRUNCATE TABLE "project_template_snapshots", "project_template_snapshot_components" CASCADE'
      )
    ).rejects.toThrow(/immutable|durable/u);
  });
});
