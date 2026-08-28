import { Prisma, ProjectStatus } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  PROCUREMENT_SETTINGS_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

export class ProcurementSettingsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "ProcurementSettingsError";
  }
}

type ProcurementModeValue = "LOCAL" | "ERP";

function requiredText(value: unknown, field: string, maximum = 191): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new ProcurementSettingsError(
      "PROC_INVALID_INPUT",
      `${field} 必须是 1 到 ${maximum} 个字符。`
    );
  }
  return value.trim();
}

function expectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProcurementSettingsError("PROC_INVALID_VERSION", "version 必须是非负整数。");
  }
  return value as number;
}

function mode(value: unknown): ProcurementModeValue {
  if (value !== "LOCAL" && value !== "ERP") {
    throw new ProcurementSettingsError("PROC_MODE_INVALID", "mode 必须为 LOCAL 或 ERP。");
  }
  return value;
}

function sourceSystem(value: unknown, procurementMode: ProcurementModeValue): string | null {
  if (procurementMode === "LOCAL") {
    if (value !== null && value !== undefined) {
      throw new ProcurementSettingsError(
        "PROC_SOURCE_SYSTEM_INVALID",
        "LOCAL 模式不能配置 ERP 来源系统。"
      );
    }
    return null;
  }
  return requiredText(value, "sourceSystem");
}

async function assertProcurementEnabled(client: Prisma.TransactionClient, projectId: string) {
  const [project, projectCapability, companyCapability] = await Promise.all([
    client.project.findUnique({ where: { id: projectId } }),
    client.projectCapability.findUnique({
      where: {
        projectId_capabilityCode: { projectId, capabilityCode: "PROCUREMENT_COLLABORATION" }
      }
    }),
    client.companyCapability.findUnique({ where: { code: "PROCUREMENT_COLLABORATION" } })
  ]);
  if (!project) throw new ProcurementSettingsError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  if (project.status === ProjectStatus.CLOSED || project.status === ProjectStatus.CANCELED) {
    throw new ProcurementSettingsError(
      "PROJECT_READ_ONLY",
      "已关闭或取消项目不能修改采购设置。",
      409
    );
  }
  if (!companyCapability?.enabled || !projectCapability?.selectedEnabled) {
    throw new ProcurementSettingsError(
      "PROC_CAPABILITY_DISABLED",
      "项目采购与物料协同能力未有效启用。",
      409
    );
  }
  return project;
}

export async function configureProjectProcurement(
  input: {
    projectId: string;
    mode: unknown;
    sourceSystem?: unknown;
    version: unknown;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = requiredText(input.projectId, "projectId");
  const procurementMode = mode(input.mode);
  const configuredSourceSystem = sourceSystem(input.sourceSystem, procurementMode);
  const version = expectedVersion(input.version);
  const reason = requiredText(input.reason, "reason", 1024);

  return inTransaction(transaction, async (client) => {
    const project = await assertProcurementEnabled(client, projectId);
    const current = await client.projectProcurementSettings.findUnique({ where: { projectId } });
    if (!current && version !== 0) {
      throw new ProcurementSettingsError(
        "VERSION_CONFLICT",
        "采购设置已发生变化，请刷新后重试。",
        409
      );
    }
    if (current && current.version !== version) {
      throw new ProcurementSettingsError(
        "VERSION_CONFLICT",
        "采购设置已发生变化，请刷新后重试。",
        409
      );
    }
    const configuredAt = await databaseNow(client);
    const settings = current
      ? await updateSettings(
          client,
          current,
          procurementMode,
          configuredSourceSystem,
          input.actorId
        )
      : await client.projectProcurementSettings.create({
          data: {
            projectId,
            mode: procurementMode,
            sourceSystem: configuredSourceSystem,
            configuredById: input.actorId,
            configuredAt,
            updatedById: input.actorId
          }
        });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.PROCUREMENT_SETTINGS_CONFIGURED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_PROCUREMENT_SETTINGS,
      objectId: projectId,
      context: {
        ...input.auditContext,
        actorId: input.actorId,
        projectId,
        departmentId: project.departmentId,
        reason
      },
      before: current
        ? {
            value: {
              projectId,
              mode: current.mode,
              sourceSystem: current.sourceSystem,
              version: current.version
            },
            allowedFields: PROCUREMENT_SETTINGS_AUDIT_FIELDS
          }
        : undefined,
      after: {
        value: {
          projectId,
          mode: settings.mode,
          sourceSystem: settings.sourceSystem,
          version: settings.version
        },
        allowedFields: PROCUREMENT_SETTINGS_AUDIT_FIELDS
      }
    });
    const event = await appendOutboxEvent(client, {
      eventType: "procurement.settings.configured",
      aggregateType: "PROJECT_PROCUREMENT_SETTINGS",
      aggregateId: projectId,
      idempotencyKey: `${projectId}:v${settings.version}`,
      payload: {
        projectId,
        mode: settings.mode,
        sourceSystem: settings.sourceSystem,
        version: settings.version,
        auditId: audit.id
      }
    });
    return {
      settings,
      resourceVersion: settings.version,
      auditId: audit.id,
      outboxEventId: event.id
    };
  });
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

async function updateSettings(
  client: Prisma.TransactionClient,
  current: { projectId: string; version: number },
  mode: ProcurementModeValue,
  sourceSystem: string | null,
  actorId: string
) {
  const updated = await client.projectProcurementSettings.updateMany({
    where: { projectId: current.projectId, version: current.version },
    data: { mode, sourceSystem, updatedById: actorId, version: { increment: 1 } }
  });
  if (updated.count !== 1) {
    throw new ProcurementSettingsError(
      "VERSION_CONFLICT",
      "采购设置已发生变化，请刷新后重试。",
      409
    );
  }
  return client.projectProcurementSettings.findUniqueOrThrow({
    where: { projectId: current.projectId }
  });
}
