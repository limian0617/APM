import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PUT as updateCapabilityRoute } from "@/app/api/projects/[projectId]/capabilities/[capabilityCode]/route";
import {
  GET as readCapabilitiesRoute,
  POST as confirmCapabilitiesRoute
} from "@/app/api/projects/[projectId]/capabilities/route";
import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  confirmProjectCapabilities,
  updateProjectCapability
} from "@/modules/configuration/application/project-capability-service";
import {
  publishProjectTemplate,
  publishTemplateComponent,
  saveProjectTemplateDraft,
  saveTemplateComponentDraft
} from "@/modules/configuration/application/template-service";
import { updateCompanyCapability } from "@/modules/configuration/application/configuration-service";
import {
  CAPABILITY_CODE_VALUES,
  type CapabilityCodeValue
} from "@/modules/configuration/domain/definitions";
import { createProjectFromTemplate } from "@/modules/projects/application/create-project";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `capability-admin-${suffix}`,
  engineer: `capability-engineer-${suffix}`,
  outsider: `capability-outsider-${suffix}`
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

function definition(type: "STAGE" | "GATE" | "ROLE" | "WBS" | "CAPABILITY_RULE") {
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
    case "CAPABILITY_RULE":
      return {
        capabilities: [
          { code: "SUPPLIER_COLLABORATION", required: true },
          { code: "CUSTOMER_PROGRESS_SHARING", required: false },
          { code: "AI_ISSUE_INTAKE", required: false }
        ]
      };
  }
}

async function seedPublishedTemplate(label: string, includeCapabilities: boolean) {
  const componentTypes = ["STAGE", "GATE", "ROLE", "WBS"] as const;
  const types = includeCapabilities
    ? [...componentTypes, "CAPABILITY_RULE" as const]
    : componentTypes;
  const versions = await Promise.all(
    types.map(async (componentType) => {
      const code = `CAPABILITY.${label}.${componentType}.${suffix}`.toUpperCase();
      const draft = await saveTemplateComponentDraft({
        code,
        componentType,
        name: `${componentType} ${label}`,
        content: definition(componentType),
        version: 0,
        reason: "创建能力测试组件",
        actorId: ids.admin,
        auditContext: context(ids.admin, `component-draft-${label}-${componentType}-${suffix}`)
      });
      return (
        await publishTemplateComponent({
          code,
          version: draft.component.version,
          reason: "发布能力测试组件",
          actorId: ids.admin,
          auditContext: context(ids.admin, `component-publish-${label}-${componentType}-${suffix}`)
        })
      ).publishedVersion;
    })
  );
  const code = `CAPABILITY.TEMPLATE.${label}.${suffix}`.toUpperCase();
  const draft = await saveProjectTemplateDraft({
    code,
    name: `${label} capability template`,
    components: versions.map((version, position) => ({
      componentVersionId: version.id,
      componentType: version.componentType,
      slot: `${version.componentType}.${position}`,
      position
    })),
    version: 0,
    reason: "创建能力测试模板",
    actorId: ids.admin,
    auditContext: context(ids.admin, `template-draft-${label}-${suffix}`)
  });
  const published = await publishProjectTemplate({
    code,
    version: draft.template.version,
    reason: "发布能力测试模板",
    actorId: ids.admin,
    auditContext: context(ids.admin, `template-publish-${label}-${suffix}`)
  });
  return { code, ...published };
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

function updateRequest(url: string, body: unknown, key: string, actorId = ids.admin) {
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
  return new Request(url, {
    headers: actorId ? { "x-apm-user-id": actorId } : undefined
  });
}

function confirmationBody(projectVersion: number, customerEnabled = true) {
  return {
    projectVersion,
    selections: [
      { code: "CUSTOMER_PROGRESS_SHARING" as const, enabled: customerEnabled },
      { code: "AI_ISSUE_INTAKE" as const, enabled: false }
    ],
    reason: "确认项目能力"
  };
}

describeDatabase("APM-013 PostgreSQL project capabilities", () => {
  let template: Awaited<ReturnType<typeof seedPublishedTemplate>>;
  let denyByDefaultTemplate: Awaited<ReturnType<typeof seedPublishedTemplate>>;
  let projectSequence = 0;

  async function createProject(label: string, source = template) {
    projectSequence += 1;
    return (
      await createProjectFromTemplate({
        code: `C13.${label}.${projectSequence}.${suffix}`.toUpperCase(),
        name: `${label} project`,
        departmentId: "engineering",
        templateCode: source.code,
        templateVersion: source.publishedVersion.version,
        templateChecksum: source.publishedVersion.checksum,
        reason: "创建能力测试项目",
        actorId: ids.admin,
        auditContext: context(ids.admin, `project-${label}-${projectSequence}-${suffix}`)
      })
    ).project;
  }

  async function setCompanyState(code: CapabilityCodeValue, enabled: boolean, label: string) {
    const current = await db.companyCapability.findUniqueOrThrow({ where: { code } });
    return updateCompanyCapability({
      code,
      enabled,
      version: current.version,
      reason: `能力测试公司开关 ${enabled}`,
      actorId: ids.admin,
      auditContext: context(ids.admin, `company-${label}-${code}-${current.version}-${suffix}`)
    });
  }

  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `CAPABILITY-ADMIN-${suffix}`,
          name: "项目能力管理员",
          departmentId: "engineering"
        },
        {
          id: ids.engineer,
          employeeNo: `CAPABILITY-ENGINEER-${suffix}`,
          name: "项目能力只读成员",
          departmentId: "engineering"
        },
        {
          id: ids.outsider,
          employeeNo: `CAPABILITY-OUTSIDER-${suffix}`,
          name: "项目能力非成员",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `capability-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        { id: `capability-role-engineer-${suffix}`, userId: ids.engineer, roleId: "role-engineer" },
        { id: `capability-role-outsider-${suffix}`, userId: ids.outsider, roleId: "role-engineer" }
      ]
    });
    template = await seedPublishedTemplate("BASE", true);
    denyByDefaultTemplate = await seedPublishedTemplate("DENY", false);
  });

  beforeEach(async () => {
    const states: Record<CapabilityCodeValue, boolean> = {
      SUPPLIER_COLLABORATION: false,
      CUSTOMER_PROGRESS_SHARING: true,
      AI_ISSUE_INTAKE: true,
      UPH_ANALYSIS: true,
      INCENTIVE_MANAGEMENT: false
    };
    for (const code of CAPABILITY_CODE_VALUES) {
      await setCompanyState(code, states[code], `reset-${projectSequence}`);
    }
  });

  it("confirms frozen template selections and evaluates current company state", async () => {
    const project = await createProject("CONFIRM");
    const url = `http://localhost/api/projects/${project.id}/capabilities`;
    const draft = await readCapabilitiesRoute(readRequest(url, ids.admin), {
      params: Promise.resolve({ projectId: project.id })
    });
    const draftBody = (await draft.json()) as {
      project: { capabilityConfigurationStatus: string };
      capabilities: Array<{
        code: string;
        selectedEnabled: boolean | null;
        effectiveEnabled: boolean;
      }>;
      allowedActions: string[];
    };
    expect(draft.status).toBe(200);
    expect(draftBody.project.capabilityConfigurationStatus).toBe("UNCONFIGURED");
    expect(draftBody.capabilities.every(({ selectedEnabled }) => selectedEnabled === null)).toBe(
      true
    );
    expect(draftBody.capabilities.every(({ effectiveEnabled }) => !effectiveEnabled)).toBe(true);
    expect(draftBody.allowedActions).toEqual(["CONFIRM_CAPABILITIES"]);

    const body = confirmationBody(project.version);
    const first = await confirmCapabilitiesRoute(commandRequest(url, body, `confirm-${suffix}`), {
      params: Promise.resolve({ projectId: project.id })
    });
    const firstBody = (await first.json()) as {
      capabilities: Array<{
        code: string;
        selectedEnabled: boolean;
        effectiveEnabled: boolean;
        disabledReasons: string[];
        sourceSnapshotComponentId: string | null;
      }>;
      resourceVersion: number;
    };
    const replay = await confirmCapabilitiesRoute(commandRequest(url, body, `confirm-${suffix}`), {
      params: Promise.resolve({ projectId: project.id })
    });
    const conflict = await confirmCapabilitiesRoute(
      commandRequest(
        url,
        { ...body, selections: [{ code: "CUSTOMER_PROGRESS_SHARING", enabled: false }] },
        `confirm-${suffix}`
      ),
      { params: Promise.resolve({ projectId: project.id }) }
    );

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);
    expect(conflict.status).toBe(409);
    expect(firstBody.resourceVersion).toBe(project.version + 1);
    expect(firstBody.capabilities).toHaveLength(5);
    expect(
      firstBody.capabilities.find(({ code }) => code === "SUPPLIER_COLLABORATION")
    ).toMatchObject({
      selectedEnabled: true,
      effectiveEnabled: false,
      disabledReasons: ["COMPANY_DISABLED"]
    });
    expect(
      firstBody.capabilities.find(({ code }) => code === "CUSTOMER_PROGRESS_SHARING")
    ).toMatchObject({ selectedEnabled: true, effectiveEnabled: true });
    expect(firstBody.capabilities.find(({ code }) => code === "UPH_ANALYSIS")).toMatchObject({
      selectedEnabled: false,
      effectiveEnabled: false,
      sourceSnapshotComponentId: null
    });
    await expect(db.projectCapability.count({ where: { projectId: project.id } })).resolves.toBe(5);
    await expect(
      db.projectCapabilityRevision.count({ where: { projectId: project.id } })
    ).resolves.toBe(5);
    await expect(
      db.auditLog.count({
        where: { projectId: project.id, action: "PROJECT_CAPABILITIES_CONFIRMED" }
      })
    ).resolves.toBe(1);
    await expect(
      db.outboxEvent.count({
        where: {
          aggregateId: project.id,
          eventType: "configuration.project-capabilities.confirmed"
        }
      })
    ).resolves.toBe(1);

    await setCompanyState("SUPPLIER_COLLABORATION", true, "activate-after-confirm");
    const refreshed = await readCapabilitiesRoute(readRequest(url, ids.admin), {
      params: Promise.resolve({ projectId: project.id })
    });
    const refreshedBody = (await refreshed.json()) as {
      capabilities: Array<{ code: string; selectedEnabled: boolean; effectiveEnabled: boolean }>;
    };
    expect(
      refreshedBody.capabilities.find(({ code }) => code === "SUPPLIER_COLLABORATION")
    ).toMatchObject({ selectedEnabled: true, effectiveEnabled: true });
    await expect(
      db.projectCapabilityRevision.count({
        where: { projectId: project.id, capabilityCode: "SUPPLIER_COLLABORATION" }
      })
    ).resolves.toBe(1);
  });

  it("enforces project authorization, optimistic updates, and company override", async () => {
    const project = await createProject("UPDATE");
    await db.projectMember.create({
      data: {
        projectId: project.id,
        userId: ids.engineer,
        projectRole: "VIEWER",
        departmentId: "engineering",
        assignedById: ids.admin
      }
    });
    await confirmProjectCapabilities({
      projectId: project.id,
      ...confirmationBody(project.version, false),
      actorId: ids.admin,
      auditContext: context(ids.admin, `confirm-update-${suffix}`, project.id)
    });
    const collectionUrl = `http://localhost/api/projects/${project.id}/capabilities`;
    const reader = await readCapabilitiesRoute(readRequest(collectionUrl, ids.engineer), {
      params: Promise.resolve({ projectId: project.id })
    });
    const outsider = await readCapabilitiesRoute(readRequest(collectionUrl, ids.outsider), {
      params: Promise.resolve({ projectId: project.id })
    });
    const forbidden = await updateCapabilityRoute(
      updateRequest(
        `${collectionUrl}/CUSTOMER_PROGRESS_SHARING`,
        { version: 1, enabled: true, reason: "无权更新" },
        `forbidden-${suffix}`,
        ids.engineer
      ),
      {
        params: Promise.resolve({
          projectId: project.id,
          capabilityCode: "CUSTOMER_PROGRESS_SHARING"
        })
      }
    );
    expect(reader.status).toBe(200);
    expect(outsider.status).toBe(403);
    expect(forbidden.status).toBe(403);

    const customerUrl = `${collectionUrl}/CUSTOMER_PROGRESS_SHARING`;
    const updateBody = { version: 1, enabled: true, reason: "启用客户进度分享" };
    const enabled = await updateCapabilityRoute(
      updateRequest(customerUrl, updateBody, `enable-customer-${suffix}`),
      {
        params: Promise.resolve({
          projectId: project.id,
          capabilityCode: "CUSTOMER_PROGRESS_SHARING"
        })
      }
    );
    const enabledBody = (await enabled.json()) as {
      capability: { selectedEnabled: boolean; effectiveEnabled: boolean; selectionVersion: number };
    };
    const replay = await updateCapabilityRoute(
      updateRequest(customerUrl, updateBody, `enable-customer-${suffix}`),
      {
        params: Promise.resolve({
          projectId: project.id,
          capabilityCode: "CUSTOMER_PROGRESS_SHARING"
        })
      }
    );
    expect(enabled.status).toBe(200);
    expect(enabledBody.capability).toMatchObject({
      selectedEnabled: true,
      effectiveEnabled: true,
      selectionVersion: 2
    });
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.json()).toEqual(enabledBody);

    const stale = await updateCapabilityRoute(
      updateRequest(
        customerUrl,
        { version: 1, enabled: false, reason: "过期版本" },
        `stale-customer-${suffix}`
      ),
      {
        params: Promise.resolve({
          projectId: project.id,
          capabilityCode: "CUSTOMER_PROGRESS_SHARING"
        })
      }
    );
    const required = await updateCapabilityRoute(
      updateRequest(
        `${collectionUrl}/SUPPLIER_COLLABORATION`,
        { version: 1, enabled: false, reason: "不允许关闭必需能力" },
        `required-${suffix}`
      ),
      {
        params: Promise.resolve({
          projectId: project.id,
          capabilityCode: "SUPPLIER_COLLABORATION"
        })
      }
    );
    expect(stale.status).toBe(409);
    expect(required.status).toBe(409);

    await setCompanyState("AI_ISSUE_INTAKE", false, "disable-ai");
    const ai = await updateProjectCapability({
      projectId: project.id,
      capabilityCode: "AI_ISSUE_INTAKE",
      version: 1,
      enabled: true,
      reason: "项目选择AI但公司关闭",
      actorId: ids.admin,
      auditContext: context(ids.admin, `select-ai-${suffix}`, project.id)
    });
    expect(ai.capability).toMatchObject({
      selectedEnabled: true,
      companyEnabled: false,
      effectiveEnabled: false,
      disabledReasons: ["COMPANY_DISABLED"]
    });
    await expect(
      db.auditLog.count({
        where: { projectId: project.id, action: "PROJECT_CAPABILITY_CHANGED" }
      })
    ).resolves.toBe(2);
  });

  it("serializes concurrent confirmation and rolls every failed transaction back", async () => {
    const concurrentProject = await createProject("CONCURRENT");
    const url = `http://localhost/api/projects/${concurrentProject.id}/capabilities`;
    const body = confirmationBody(concurrentProject.version);
    const outcomes = await Promise.all([
      confirmCapabilitiesRoute(commandRequest(url, body, `concurrent-a-${suffix}`), {
        params: Promise.resolve({ projectId: concurrentProject.id })
      }),
      confirmCapabilitiesRoute(commandRequest(url, body, `concurrent-b-${suffix}`), {
        params: Promise.resolve({ projectId: concurrentProject.id })
      })
    ]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual([201, 409]);
    await expect(
      db.projectCapability.count({ where: { projectId: concurrentProject.id } })
    ).resolves.toBe(5);
    await expect(
      db.auditLog.count({
        where: { projectId: concurrentProject.id, action: "PROJECT_CAPABILITIES_CONFIRMED" }
      })
    ).resolves.toBe(1);

    const staleProject = await createProject("STALE");
    await expect(
      confirmProjectCapabilities({
        projectId: staleProject.id,
        ...confirmationBody(staleProject.version + 1),
        actorId: ids.admin,
        auditContext: context(ids.admin, `stale-${suffix}`, staleProject.id)
      })
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
    await expect(
      db.projectCapability.count({ where: { projectId: staleProject.id } })
    ).resolves.toBe(0);

    const rollbackProject = await createProject("ROLLBACK");
    await expect(
      confirmProjectCapabilities({
        projectId: rollbackProject.id,
        ...confirmationBody(rollbackProject.version),
        actorId: `missing-capability-actor-${suffix}`,
        auditContext: context(
          `missing-capability-actor-${suffix}`,
          `rollback-${suffix}`,
          rollbackProject.id
        )
      })
    ).rejects.toMatchObject({ code: "PROJECT_CAPABILITY_RELATION_INVALID", status: 409 });
    await expect(
      db.project.findUniqueOrThrow({ where: { id: rollbackProject.id } })
    ).resolves.toMatchObject({
      capabilityConfigurationStatus: "UNCONFIGURED",
      capabilitiesConfiguredAt: null,
      version: rollbackProject.version
    });
    await expect(
      db.projectCapability.count({ where: { projectId: rollbackProject.id } })
    ).resolves.toBe(0);
    await expect(
      db.auditLog.count({
        where: { projectId: rollbackProject.id, action: "PROJECT_CAPABILITIES_CONFIRMED" }
      })
    ).resolves.toBe(0);

    const denyProject = await createProject("DEFAULTDENY", denyByDefaultTemplate);
    const denied = await confirmProjectCapabilities({
      projectId: denyProject.id,
      projectVersion: denyProject.version,
      selections: [],
      reason: "无能力规则时默认全部关闭",
      actorId: ids.admin,
      auditContext: context(ids.admin, `default-deny-${suffix}`, denyProject.id)
    });
    expect(
      denied.capabilities.every(
        ({ templateAllowed, selectedEnabled, effectiveEnabled }) =>
          !templateAllowed && !selectedEnabled && !effectiveEnabled
      )
    ).toBe(true);
  });

  it("enforces frozen policy, revision integrity, and no physical removal in PostgreSQL", async () => {
    const firstProject = await createProject("DBA");
    await confirmProjectCapabilities({
      projectId: firstProject.id,
      ...confirmationBody(firstProject.version, false),
      actorId: ids.admin,
      auditContext: context(ids.admin, `db-a-${suffix}`, firstProject.id)
    });
    const secondProject = await createProject("DBB");
    await confirmProjectCapabilities({
      projectId: secondProject.id,
      ...confirmationBody(secondProject.version, false),
      actorId: ids.admin,
      auditContext: context(ids.admin, `db-b-${suffix}`, secondProject.id)
    });
    const firstCustomer = await db.projectCapability.findUniqueOrThrow({
      where: {
        projectId_capabilityCode: {
          projectId: firstProject.id,
          capabilityCode: "CUSTOMER_PROGRESS_SHARING"
        }
      }
    });
    const secondCustomer = await db.projectCapability.findUniqueOrThrow({
      where: {
        projectId_capabilityCode: {
          projectId: secondProject.id,
          capabilityCode: "CUSTOMER_PROGRESS_SHARING"
        }
      }
    });
    await expect(
      db.projectCapability.update({
        where: {
          projectId_capabilityCode: {
            projectId: firstProject.id,
            capabilityCode: "CUSTOMER_PROGRESS_SHARING"
          }
        },
        data: { templateAllowed: false }
      })
    ).rejects.toThrow(/template policy is immutable/u);
    await expect(
      db.projectCapability.update({
        where: {
          projectId_capabilityCode: {
            projectId: firstProject.id,
            capabilityCode: "CUSTOMER_PROGRESS_SHARING"
          }
        },
        data: { sourceSnapshotComponentId: secondCustomer.sourceSnapshotComponentId }
      })
    ).rejects.toThrow(/same project|immutable/u);
    await expect(
      db.projectCapability.update({
        where: {
          projectId_capabilityCode: {
            projectId: firstProject.id,
            capabilityCode: "SUPPLIER_COLLABORATION"
          }
        },
        data: { selectedEnabled: false }
      })
    ).rejects.toThrow();
    await expect(
      db.$transaction(async (transaction) => {
        const changed = await transaction.projectCapability.update({
          where: {
            projectId_capabilityCode: {
              projectId: firstProject.id,
              capabilityCode: "CUSTOMER_PROGRESS_SHARING"
            }
          },
          data: { selectedEnabled: true, version: { increment: 1 }, updatedById: ids.admin }
        });
        await transaction.projectCapabilityRevision.create({
          data: {
            projectId: firstProject.id,
            capabilityCode: "CUSTOMER_PROGRESS_SHARING",
            version: changed.version,
            templateAllowed: changed.templateAllowed,
            templateRequired: changed.templateRequired,
            selectedEnabled: changed.selectedEnabled,
            sourceSnapshotComponentId: changed.sourceSnapshotComponentId,
            companyEnabled: true,
            companyVersion: 1,
            effectiveEnabled: false,
            changedById: ids.admin,
            changeReason: "错误有效值"
          }
        });
      })
    ).rejects.toThrow();
    await expect(
      db.projectCapability.findUniqueOrThrow({
        where: {
          projectId_capabilityCode: {
            projectId: firstProject.id,
            capabilityCode: "CUSTOMER_PROGRESS_SHARING"
          }
        }
      })
    ).resolves.toMatchObject({
      selectedEnabled: firstCustomer.selectedEnabled,
      version: firstCustomer.version
    });
    const revision = await db.projectCapabilityRevision.findFirstOrThrow({
      where: { projectId: firstProject.id }
    });
    await expect(
      db.projectCapabilityRevision.update({
        where: { id: revision.id },
        data: { changeReason: "mutated" }
      })
    ).rejects.toThrow(/durable and cannot be removed/u);
    await expect(
      db.projectCapabilityRevision.delete({ where: { id: revision.id } })
    ).rejects.toThrow(/durable and cannot be removed/u);
    await expect(
      db.projectCapability.delete({
        where: {
          projectId_capabilityCode: {
            projectId: firstProject.id,
            capabilityCode: "CUSTOMER_PROGRESS_SHARING"
          }
        }
      })
    ).rejects.toThrow(/durable and cannot be removed/u);
    await expect(
      db.project.update({
        where: { id: firstProject.id },
        data: { capabilityConfigurationStatus: "UNCONFIGURED" }
      })
    ).rejects.toThrow(/configuration is immutable/u);
    await expect(
      db.$executeRawUnsafe('TRUNCATE TABLE "project_capability_revisions", "project_capabilities"')
    ).rejects.toThrow(/durable and cannot be removed/u);
  });
});
