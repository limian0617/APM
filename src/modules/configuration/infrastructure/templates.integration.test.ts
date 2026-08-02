import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { POST as publishTemplateRoute } from "@/app/api/templates/[code]/versions/route";
import { PUT as saveTemplateRoute } from "@/app/api/templates/[code]/route";
import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  compareProjectTemplateVersions,
  publishProjectTemplate,
  publishTemplateComponent,
  saveProjectTemplateDraft,
  saveTemplateComponentDraft,
  setProjectTemplateEnabled
} from "@/modules/configuration/application/template-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `template-admin-${suffix}`,
  engineer: `template-engineer-${suffix}`
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

async function publishedComponent(type: "STAGE" | "GATE" | "ROLE" | "WBS", label: string) {
  const code = `TEST.${type}.${label}.${suffix}`.toUpperCase();
  const draft = await saveTemplateComponentDraft({
    code,
    componentType: type,
    name: `${type} component`,
    content: componentDefinition(type),
    version: 0,
    reason: "创建测试组件",
    actorId: ids.admin,
    auditContext: context(ids.admin, `draft-${code}`)
  });
  const published = await publishTemplateComponent({
    code,
    version: draft.component.version,
    reason: "发布测试组件",
    actorId: ids.admin,
    auditContext: context(ids.admin, `publish-${code}`)
  });
  return published.publishedVersion;
}

function references(components: Awaited<ReturnType<typeof publishedComponent>>[]) {
  return components.map((component, position) => ({
    componentVersionId: component.id,
    componentType: component.componentType,
    slot: `${component.componentType}.${position}`,
    position
  }));
}

function request(url: string, body: unknown, key: string, userId = ids.admin) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-apm-user-id": userId,
      "idempotency-key": key,
      "x-request-id": `request-${key}`
    },
    body: JSON.stringify(body)
  });
}

describeDatabase("APM-010 PostgreSQL template versions", () => {
  let completeComponents: Awaited<ReturnType<typeof publishedComponent>>[];

  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `TEMPLATE-ADMIN-${suffix}`,
          name: "模板管理员",
          departmentId: "hq"
        },
        {
          id: ids.engineer,
          employeeNo: `TEMPLATE-ENGINEER-${suffix}`,
          name: "模板只读用户",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `template-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        { id: `template-role-engineer-${suffix}`, userId: ids.engineer, roleId: "role-engineer" }
      ]
    });
    completeComponents = await Promise.all(
      (["STAGE", "GATE", "ROLE", "WBS"] as const).map((type) => publishedComponent(type, "BASE"))
    );
  });

  it("rejects missing versions, mismatched types, duplicate positions, and incomplete templates", async () => {
    const code = `TEST.INVALID.${suffix}`.toUpperCase();
    await expect(
      saveProjectTemplateDraft({
        code,
        name: "Invalid",
        components: [
          {
            componentVersionId: `missing-${suffix}`,
            componentType: "STAGE",
            slot: "STAGE.0",
            position: 0
          }
        ],
        version: 0,
        reason: "不存在的版本",
        actorId: ids.admin,
        auditContext: context(ids.admin, `missing-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "COMPONENT_VERSION_NOT_FOUND", status: 422 });
    await expect(
      saveProjectTemplateDraft({
        code,
        name: "Invalid",
        components: [
          {
            componentVersionId: completeComponents[0]!.id,
            componentType: "WBS",
            slot: "WRONG.0",
            position: 0
          }
        ],
        version: 0,
        reason: "类型不匹配",
        actorId: ids.admin,
        auditContext: context(ids.admin, `type-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "COMPONENT_TYPE_MISMATCH" });
    await expect(
      saveProjectTemplateDraft({
        code,
        name: "Invalid",
        components: [
          ...references(completeComponents).slice(0, 2),
          { ...references(completeComponents)[2]!, position: 1 }
        ],
        version: 0,
        reason: "重复位置",
        actorId: ids.admin,
        auditContext: context(ids.admin, `position-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "DUPLICATE_TEMPLATE_POSITION" });

    const incompleteCode = `TEST.INCOMPLETE.${suffix}`.toUpperCase();
    const draft = await saveProjectTemplateDraft({
      code: incompleteCode,
      name: "Incomplete",
      components: references(completeComponents).slice(0, 1),
      version: 0,
      reason: "保存未完成草稿",
      actorId: ids.admin,
      auditContext: context(ids.admin, `incomplete-draft-${suffix}`)
    });
    await expect(
      publishProjectTemplate({
        code: incompleteCode,
        version: draft.template.version,
        reason: "不应发布",
        actorId: ids.admin,
        auditContext: context(ids.admin, `incomplete-publish-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "INCOMPLETE_TEMPLATE" });
  });

  it("publishes atomically, supports API idempotency, and denies unauthorized writes", async () => {
    const code = `TEST.API.${suffix}`.toUpperCase();
    const draftBody = {
      version: 0,
      name: "API template",
      components: references(completeComponents),
      reason: "API 保存草稿"
    };
    const draftResponse = await saveTemplateRoute(
      new Request(`http://localhost/api/templates/${code}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-apm-user-id": ids.admin,
          "idempotency-key": `draft-${suffix}`
        },
        body: JSON.stringify(draftBody)
      }),
      { params: Promise.resolve({ code }) }
    );
    expect(draftResponse.status).toBe(201);
    const draft = (await draftResponse.json()) as { template: { version: number } };
    const publishBody = { version: draft.template.version, reason: "API 发布" };
    const first = await publishTemplateRoute(
      request(`http://localhost/api/templates/${code}/versions`, publishBody, `publish-${suffix}`),
      { params: Promise.resolve({ code }) }
    );
    const replay = await publishTemplateRoute(
      request(`http://localhost/api/templates/${code}/versions`, publishBody, `publish-${suffix}`),
      { params: Promise.resolve({ code }) }
    );
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
    const conflict = await publishTemplateRoute(
      request(
        `http://localhost/api/templates/${code}/versions`,
        { ...publishBody, reason: "不同请求" },
        `publish-${suffix}`
      ),
      { params: Promise.resolve({ code }) }
    );
    expect(conflict.status).toBe(409);

    const forbidden = await publishTemplateRoute(
      request(
        `http://localhost/api/templates/${code}/versions`,
        publishBody,
        `forbidden-${suffix}`,
        ids.engineer
      ),
      { params: Promise.resolve({ code }) }
    );
    expect(forbidden.status).toBe(403);
    await expect(
      db.auditLog.count({
        where: {
          action: "TEMPLATE_PUBLISHED",
          objectType: "TEMPLATE_VERSION",
          actorId: ids.admin
        }
      })
    ).resolves.toBeGreaterThanOrEqual(1);
    await expect(
      db.outboxEvent.count({ where: { eventType: "configuration.template.published" } })
    ).resolves.toBeGreaterThanOrEqual(1);
  });

  it("allows only one concurrent publish for an optimistic version", async () => {
    const code = `TEST.CONCURRENT.${suffix}`.toUpperCase();
    const draft = await saveProjectTemplateDraft({
      code,
      name: "Concurrent",
      components: references(completeComponents),
      version: 0,
      reason: "并发草稿",
      actorId: ids.admin,
      auditContext: context(ids.admin, `concurrent-draft-${suffix}`)
    });
    const command = (operation: string) =>
      publishProjectTemplate({
        code,
        version: draft.template.version,
        reason: operation,
        actorId: ids.admin,
        auditContext: context(ids.admin, operation)
      });
    const outcomes = await Promise.allSettled([
      command(`concurrent-a-${suffix}`),
      command(`concurrent-b-${suffix}`)
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(
      db.projectTemplateVersion.count({ where: { templateId: draft.template.id } })
    ).resolves.toBe(1);
  });

  it("keeps published versions and exact references immutable after disable", async () => {
    const code = `TEST.IMMUTABLE.${suffix}`.toUpperCase();
    const draft = await saveProjectTemplateDraft({
      code,
      name: "Immutable V1",
      components: references(completeComponents),
      version: 0,
      reason: "不可变草稿",
      actorId: ids.admin,
      auditContext: context(ids.admin, `immutable-draft-${suffix}`)
    });
    const first = await publishProjectTemplate({
      code,
      version: draft.template.version,
      reason: "发布不可变版本",
      actorId: ids.admin,
      auditContext: context(ids.admin, `immutable-publish-${suffix}`)
    });
    const snapshot = await db.projectTemplateVersion.findUniqueOrThrow({
      where: { id: first.publishedVersion.id },
      include: { components: { orderBy: { position: "asc" } } }
    });
    await setProjectTemplateEnabled({
      code,
      version: first.template.version,
      enabled: false,
      reason: "停用但保留历史",
      actorId: ids.admin,
      auditContext: context(ids.admin, `immutable-disable-${suffix}`)
    });
    await expect(
      db.projectTemplateVersion.findUniqueOrThrow({
        where: { id: first.publishedVersion.id },
        include: { components: { orderBy: { position: "asc" } } }
      })
    ).resolves.toEqual(snapshot);
    await expect(
      db.projectTemplateVersion.update({
        where: { id: first.publishedVersion.id },
        data: { name: "mutated" }
      })
    ).rejects.toThrow(/immutable/u);
    await expect(
      db.templateVersionComponent.delete({ where: { id: snapshot.components[0]!.id } })
    ).rejects.toThrow(/immutable/u);
    await expect(db.$executeRawUnsafe('TRUNCATE TABLE "template_versions"')).rejects.toThrow(
      /immutable/u
    );
    await expect(
      db.templateComponentVersion.update({
        where: { id: completeComponents[0]!.id },
        data: { name: "mutated" }
      })
    ).rejects.toThrow(/immutable/u);
  });

  it("returns a deterministic structural diff between published versions", async () => {
    const code = `TEST.DIFF.${suffix}`.toUpperCase();
    const firstDraft = await saveProjectTemplateDraft({
      code,
      name: "Diff V1",
      components: references(completeComponents),
      version: 0,
      reason: "差异版本一",
      actorId: ids.admin,
      auditContext: context(ids.admin, `diff-draft-1-${suffix}`)
    });
    const first = await publishProjectTemplate({
      code,
      version: firstDraft.template.version,
      reason: "发布版本一",
      actorId: ids.admin,
      auditContext: context(ids.admin, `diff-publish-1-${suffix}`)
    });
    const changedStage = await publishedComponent("STAGE", "DIFF2");
    const nextReferences = references(completeComponents).map((reference) =>
      reference.componentType === "STAGE"
        ? { ...reference, componentVersionId: changedStage.id }
        : reference
    );
    const secondDraft = await saveProjectTemplateDraft({
      code,
      name: "Diff V2",
      components: nextReferences,
      version: first.template.version,
      reason: "差异版本二",
      actorId: ids.admin,
      auditContext: context(ids.admin, `diff-draft-2-${suffix}`)
    });
    const second = await publishProjectTemplate({
      code,
      version: secondDraft.template.version,
      reason: "发布版本二",
      actorId: ids.admin,
      auditContext: context(ids.admin, `diff-publish-2-${suffix}`)
    });
    const diff = await compareProjectTemplateVersions({ code, fromVersion: 1, toVersion: 2 });
    expect(diff.metadata).toEqual([{ field: "name", from: "Diff V1", to: "Diff V2" }]);
    expect(diff.components.changed).toHaveLength(1);
    expect(diff.components.changed[0]).toMatchObject({ slot: "STAGE.0" });
    expect(diff.from.checksum).toBe(first.publishedVersion.checksum);
    expect(diff.to.checksum).toBe(second.publishedVersion.checksum);
  });
});
