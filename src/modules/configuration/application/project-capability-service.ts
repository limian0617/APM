import { CapabilityCode, Prisma, ProjectStatus } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  PROJECT_CAPABILITIES_AUDIT_FIELDS,
  PROJECT_CAPABILITY_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  CAPABILITY_CODE_VALUES,
  isCapabilityCode,
  type CapabilityCodeValue
} from "../domain/definitions";
import {
  assertCapabilityChangeAllowed,
  capabilityEffectiveState,
  ProjectCapabilityError,
  resolveProjectCapabilitySelections,
  resolveTemplateCapabilityPolicy,
  type CapabilityPolicy,
  type CapabilitySelection
} from "../domain/project-capability";

type CompanyCapabilityState = {
  code: CapabilityCode;
  enabled: boolean;
  version: number;
};

type StoredSelection = CapabilitySelection & {
  version: number;
};

function positiveVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProjectCapabilityError("INVALID_VERSION", `${field} 必须是正整数。`);
  }
  return value as number;
}

function commandReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new ProjectCapabilityError("REASON_REQUIRED", "操作原因必须是 1 到 1024 个字符。");
  }
  return value.trim();
}

function requireCapabilityCode(value: string): CapabilityCodeValue {
  if (!isCapabilityCode(value)) {
    throw new ProjectCapabilityError("UNKNOWN_CAPABILITY", "项目能力代码不存在。", 404);
  }
  return value;
}

function companyStateByCode(rows: CompanyCapabilityState[]) {
  const byCode = new Map(rows.map((row) => [row.code as CapabilityCodeValue, row]));
  for (const code of CAPABILITY_CODE_VALUES) {
    if (!byCode.has(code)) {
      throw new ProjectCapabilityError(
        "COMPANY_CAPABILITY_CONFIGURATION_MISSING",
        `公司能力 ${code} 缺少受控配置。`,
        409
      );
    }
  }
  return byCode;
}

function capabilityView(
  selection: CapabilityPolicy & { selectedEnabled: boolean | null; version: number | null },
  company: CompanyCapabilityState,
  configured: boolean
) {
  const selectedForEvaluation = configured && selection.selectedEnabled === true;
  const effective = capabilityEffectiveState({
    companyEnabled: company.enabled,
    templateAllowed: selection.templateAllowed,
    selectedEnabled: selectedForEvaluation
  });
  return {
    code: selection.code,
    companyEnabled: company.enabled,
    companyVersion: company.version,
    templateAllowed: selection.templateAllowed,
    templateRequired: selection.templateRequired,
    templateDefaultEnabled: selection.templateRequired,
    sourceSnapshotComponentId: selection.sourceSnapshotComponentId,
    selectedEnabled: configured ? selection.selectedEnabled : null,
    selectionVersion: configured ? selection.version : null,
    ...effective,
    allowedActions:
      configured && selection.templateAllowed && !selection.templateRequired
        ? [selection.selectedEnabled ? "DISABLE" : "ENABLE"]
        : []
  };
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new ProjectCapabilityError(
        "PROJECT_CAPABILITY_CONFLICT",
        "项目能力已经配置或修订版本冲突。",
        409
      );
    }
    if (error.code === "P2003" || error.code === "P2004") {
      throw new ProjectCapabilityError(
        "PROJECT_CAPABILITY_RELATION_INVALID",
        "项目能力关系未通过数据库约束。",
        409
      );
    }
  }
  throw error;
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

function snapshotPolicies(
  snapshot: {
    components: Array<{ id: string; contentJson: Prisma.JsonValue }>;
  } | null
) {
  if (!snapshot) {
    throw new ProjectCapabilityError(
      "PROJECT_TEMPLATE_NOT_READY",
      "项目模板快照尚未准备完成。",
      409
    );
  }
  return resolveTemplateCapabilityPolicy(snapshot.components);
}

export async function readProjectCapabilities(projectId: string) {
  const [project, companies] = await Promise.all([
    db.project.findUnique({
      where: { id: projectId },
      include: {
        templateSnapshot: {
          include: {
            components: {
              where: { componentType: "CAPABILITY_RULE" },
              orderBy: [{ position: "asc" }, { slot: "asc" }]
            }
          }
        },
        projectCapabilities: { orderBy: { capabilityCode: "asc" } }
      }
    }),
    db.companyCapability.findMany({
      where: { code: { in: CAPABILITY_CODE_VALUES as CapabilityCode[] } },
      orderBy: { code: "asc" }
    })
  ]);
  if (!project) throw new ProjectCapabilityError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  if (project.initializationStatus !== "READY") {
    throw new ProjectCapabilityError(
      "PROJECT_TEMPLATE_NOT_READY",
      "项目模板快照尚未准备完成。",
      409
    );
  }
  const policies = snapshotPolicies(project.templateSnapshot);
  const companyByCode = companyStateByCode(companies);
  const configured = project.capabilityConfigurationStatus === "READY";
  const storedByCode = new Map(
    project.projectCapabilities.map((row) => [row.capabilityCode as CapabilityCodeValue, row])
  );
  if (
    (configured && storedByCode.size !== CAPABILITY_CODE_VALUES.length) ||
    (!configured && storedByCode.size !== 0)
  ) {
    throw new ProjectCapabilityError(
      "PROJECT_CAPABILITY_CONFIGURATION_INCONSISTENT",
      "项目能力配置不完整。",
      409
    );
  }

  return {
    project: {
      id: project.id,
      code: project.code,
      capabilityConfigurationStatus: project.capabilityConfigurationStatus,
      capabilitiesConfiguredAt: project.capabilitiesConfiguredAt
    },
    resourceVersion: project.version,
    capabilities: policies.map((policy) => {
      const stored = storedByCode.get(policy.code);
      if (
        stored &&
        (stored.templateAllowed !== policy.templateAllowed ||
          stored.templateRequired !== policy.templateRequired ||
          stored.sourceSnapshotComponentId !== policy.sourceSnapshotComponentId)
      ) {
        throw new ProjectCapabilityError(
          "PROJECT_CAPABILITY_POLICY_MISMATCH",
          `项目能力 ${policy.code} 与冻结模板策略不一致。`,
          409
        );
      }
      return capabilityView(
        {
          ...policy,
          selectedEnabled: stored?.selectedEnabled ?? null,
          version: stored?.version ?? null
        },
        companyByCode.get(policy.code)!,
        configured
      );
    }),
    allowedActions: configured ? [] : ["CONFIRM_CAPABILITIES"]
  };
}

export async function confirmProjectCapabilities(
  input: {
    projectId: string;
    projectVersion: number;
    selections: Array<{ code: CapabilityCodeValue; enabled: boolean }>;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectVersion = positiveVersion(input.projectVersion, "projectVersion");
  const reason = commandReason(input.reason);

  try {
    return await inTransaction(transaction, async (client) => {
      const [project, companies] = await Promise.all([
        client.project.findUnique({
          where: { id: input.projectId },
          include: {
            templateSnapshot: {
              include: {
                components: {
                  where: { componentType: "CAPABILITY_RULE" },
                  orderBy: [{ position: "asc" }, { slot: "asc" }]
                }
              }
            }
          }
        }),
        client.companyCapability.findMany({
          where: { code: { in: CAPABILITY_CODE_VALUES as CapabilityCode[] } },
          orderBy: { code: "asc" }
        })
      ]);
      if (!project) throw new ProjectCapabilityError("PROJECT_NOT_FOUND", "项目不存在。", 404);
      if (project.initializationStatus !== "READY") {
        throw new ProjectCapabilityError(
          "PROJECT_TEMPLATE_NOT_READY",
          "项目模板快照尚未准备完成。",
          409
        );
      }
      if (project.status === ProjectStatus.CLOSED || project.status === ProjectStatus.CANCELED) {
        throw new ProjectCapabilityError("PROJECT_READ_ONLY", "已关闭项目不能配置能力。", 409);
      }
      if (project.capabilityConfigurationStatus === "READY") {
        throw new ProjectCapabilityError(
          "PROJECT_CAPABILITIES_ALREADY_CONFIRMED",
          "项目能力已经确认。",
          409
        );
      }
      const selections = resolveProjectCapabilitySelections(
        snapshotPolicies(project.templateSnapshot),
        input.selections
      );
      const companyByCode = companyStateByCode(companies);
      const configuredAt = await databaseNow(client);
      const updatedProject = await client.project.updateMany({
        where: {
          id: project.id,
          version: projectVersion,
          capabilityConfigurationStatus: "UNCONFIGURED"
        },
        data: {
          capabilityConfigurationStatus: "READY",
          capabilitiesConfiguredAt: configuredAt,
          version: { increment: 1 }
        }
      });
      if (updatedProject.count !== 1) {
        throw new ProjectCapabilityError(
          "VERSION_CONFLICT",
          "项目能力配置已发生变化，请刷新后重试。",
          409
        );
      }

      const stored: StoredSelection[] = [];
      for (const selection of selections) {
        const capability = await client.projectCapability.create({
          data: {
            projectId: project.id,
            capabilityCode: selection.code as CapabilityCode,
            templateAllowed: selection.templateAllowed,
            templateRequired: selection.templateRequired,
            selectedEnabled: selection.selectedEnabled,
            sourceSnapshotComponentId: selection.sourceSnapshotComponentId,
            createdById: input.actorId,
            updatedById: input.actorId
          }
        });
        const company = companyByCode.get(selection.code)!;
        const effective = capabilityEffectiveState({
          companyEnabled: company.enabled,
          templateAllowed: selection.templateAllowed,
          selectedEnabled: selection.selectedEnabled
        });
        await client.projectCapabilityRevision.create({
          data: {
            projectId: project.id,
            capabilityCode: selection.code as CapabilityCode,
            version: capability.version,
            templateAllowed: selection.templateAllowed,
            templateRequired: selection.templateRequired,
            selectedEnabled: selection.selectedEnabled,
            sourceSnapshotComponentId: selection.sourceSnapshotComponentId,
            companyEnabled: company.enabled,
            companyVersion: company.version,
            effectiveEnabled: effective.effectiveEnabled,
            changedById: input.actorId,
            changeReason: reason
          }
        });
        stored.push({ ...selection, version: capability.version });
      }

      const nextProject = await client.project.findUniqueOrThrow({ where: { id: project.id } });
      const capabilities = stored.map((selection) =>
        capabilityView(selection, companyByCode.get(selection.code)!, true)
      );
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PROJECT_CAPABILITIES_CONFIRMED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT,
        objectId: project.id,
        context: {
          ...input.auditContext,
          actorId: input.actorId,
          projectId: project.id,
          departmentId: project.departmentId,
          reason
        },
        before: {
          value: {
            projectId: project.id,
            configurationStatus: project.capabilityConfigurationStatus,
            capabilitiesConfiguredAt: project.capabilitiesConfiguredAt,
            version: project.version
          },
          allowedFields: PROJECT_CAPABILITIES_AUDIT_FIELDS
        },
        after: {
          value: {
            projectId: project.id,
            configurationStatus: nextProject.capabilityConfigurationStatus,
            capabilitiesConfiguredAt: nextProject.capabilitiesConfiguredAt,
            capabilities,
            version: nextProject.version
          },
          allowedFields: PROJECT_CAPABILITIES_AUDIT_FIELDS
        }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "configuration.project-capabilities.confirmed",
        aggregateType: "PROJECT",
        aggregateId: project.id,
        idempotencyKey: project.id,
        payload: {
          projectId: project.id,
          capabilities: capabilities.map(({ code, selectedEnabled, effectiveEnabled }) => ({
            code,
            selectedEnabled,
            effectiveEnabled
          })),
          version: nextProject.version
        }
      });
      return {
        project: {
          id: project.id,
          code: project.code,
          capabilityConfigurationStatus: nextProject.capabilityConfigurationStatus,
          capabilitiesConfiguredAt: nextProject.capabilitiesConfiguredAt
        },
        capabilities,
        resourceVersion: nextProject.version,
        allowedActions: [],
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof ProjectCapabilityError) throw error;
    mapDatabaseError(error);
  }
}

export async function updateProjectCapability(
  input: {
    projectId: string;
    capabilityCode: string;
    version: number;
    enabled: boolean;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const capabilityCode = requireCapabilityCode(input.capabilityCode);
  const version = positiveVersion(input.version, "version");
  const reason = commandReason(input.reason);

  try {
    return await inTransaction(transaction, async (client) => {
      const [project, current, company] = await Promise.all([
        client.project.findUnique({ where: { id: input.projectId } }),
        client.projectCapability.findUnique({
          where: {
            projectId_capabilityCode: {
              projectId: input.projectId,
              capabilityCode: capabilityCode as CapabilityCode
            }
          }
        }),
        client.companyCapability.findUnique({
          where: { code: capabilityCode as CapabilityCode }
        })
      ]);
      if (!project) throw new ProjectCapabilityError("PROJECT_NOT_FOUND", "项目不存在。", 404);
      if (project.status === ProjectStatus.CLOSED || project.status === ProjectStatus.CANCELED) {
        throw new ProjectCapabilityError("PROJECT_READ_ONLY", "已关闭项目不能修改能力。", 409);
      }
      if (project.capabilityConfigurationStatus !== "READY") {
        throw new ProjectCapabilityError(
          "PROJECT_CAPABILITIES_NOT_READY",
          "项目能力尚未确认。",
          409
        );
      }
      if (!current) {
        throw new ProjectCapabilityError("PROJECT_CAPABILITY_NOT_FOUND", "项目能力不存在。", 404);
      }
      if (!company) {
        throw new ProjectCapabilityError(
          "COMPANY_CAPABILITY_CONFIGURATION_MISSING",
          "公司能力缺少受控配置。",
          409
        );
      }
      const selectedEnabled = assertCapabilityChangeAllowed({
        code: capabilityCode,
        templateAllowed: current.templateAllowed,
        templateRequired: current.templateRequired,
        enabled: input.enabled
      });
      if (current.selectedEnabled === selectedEnabled) {
        throw new ProjectCapabilityError(
          "PROJECT_CAPABILITY_UNCHANGED",
          "项目能力已经处于目标选择状态。",
          409
        );
      }
      const updatedRows = await client.projectCapability.updateMany({
        where: {
          projectId: input.projectId,
          capabilityCode: capabilityCode as CapabilityCode,
          version
        },
        data: {
          selectedEnabled,
          version: { increment: 1 },
          updatedById: input.actorId
        }
      });
      if (updatedRows.count !== 1) {
        throw new ProjectCapabilityError(
          "VERSION_CONFLICT",
          "项目能力已发生变化，请刷新后重试。",
          409
        );
      }
      const updated = await client.projectCapability.findUniqueOrThrow({
        where: {
          projectId_capabilityCode: {
            projectId: input.projectId,
            capabilityCode: capabilityCode as CapabilityCode
          }
        }
      });
      const effective = capabilityEffectiveState({
        companyEnabled: company.enabled,
        templateAllowed: updated.templateAllowed,
        selectedEnabled: updated.selectedEnabled
      });
      await client.projectCapabilityRevision.create({
        data: {
          projectId: input.projectId,
          capabilityCode: capabilityCode as CapabilityCode,
          version: updated.version,
          templateAllowed: updated.templateAllowed,
          templateRequired: updated.templateRequired,
          selectedEnabled: updated.selectedEnabled,
          sourceSnapshotComponentId: updated.sourceSnapshotComponentId,
          companyEnabled: company.enabled,
          companyVersion: company.version,
          effectiveEnabled: effective.effectiveEnabled,
          changedById: input.actorId,
          changeReason: reason
        }
      });
      const beforeView = capabilityView(
        {
          code: capabilityCode,
          templateAllowed: current.templateAllowed,
          templateRequired: current.templateRequired,
          sourceSnapshotComponentId: current.sourceSnapshotComponentId,
          selectedEnabled: current.selectedEnabled,
          version: current.version
        },
        company,
        true
      );
      const afterView = capabilityView(
        {
          code: capabilityCode,
          templateAllowed: updated.templateAllowed,
          templateRequired: updated.templateRequired,
          sourceSnapshotComponentId: updated.sourceSnapshotComponentId,
          selectedEnabled: updated.selectedEnabled,
          version: updated.version
        },
        company,
        true
      );
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PROJECT_CAPABILITY_CHANGED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_CAPABILITY,
        objectId: `${input.projectId}:${capabilityCode}`,
        context: {
          ...input.auditContext,
          actorId: input.actorId,
          projectId: input.projectId,
          departmentId: project.departmentId,
          reason
        },
        before: {
          value: {
            projectId: input.projectId,
            capabilityCode,
            ...beforeView,
            version: current.version
          },
          allowedFields: PROJECT_CAPABILITY_AUDIT_FIELDS
        },
        after: {
          value: {
            projectId: input.projectId,
            capabilityCode,
            ...afterView,
            version: updated.version
          },
          allowedFields: PROJECT_CAPABILITY_AUDIT_FIELDS
        }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "configuration.project-capability.changed",
        aggregateType: "PROJECT_CAPABILITY",
        aggregateId: `${input.projectId}:${capabilityCode}`,
        idempotencyKey: `${input.projectId}:${capabilityCode}:v${updated.version}`,
        payload: {
          projectId: input.projectId,
          capabilityCode,
          selectedEnabled: updated.selectedEnabled,
          effectiveEnabled: effective.effectiveEnabled,
          version: updated.version
        }
      });
      return {
        capability: afterView,
        resourceVersion: updated.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof ProjectCapabilityError) throw error;
    mapDatabaseError(error);
  }
}
