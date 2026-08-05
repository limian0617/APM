import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  COMPANY_CAPABILITY_AUDIT_FIELDS,
  SYSTEM_SETTING_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import type { UpdateCapabilityCommand, UpdateSettingCommand } from "../contracts/configuration";
import {
  CAPABILITY_CODE_VALUES,
  ConfigurationValidationError,
  isCapabilityCode,
  isRuntimeSettingKey,
  RUNTIME_SETTING_DEFINITIONS,
  SETTING_VALUE_TYPES,
  validateReason,
  validateRuntimeSettingValue,
  validateVersion
} from "../domain/definitions";

export async function getConfiguration() {
  const [settings, capabilities] = await Promise.all([
    db.systemSetting.findMany({ orderBy: { key: "asc" } }),
    db.companyCapability.findMany({ orderBy: { code: "asc" } })
  ]);

  return {
    settings: settings.flatMap((setting) =>
      isRuntimeSettingKey(setting.key)
        ? [
            {
              ...setting,
              description: RUNTIME_SETTING_DEFINITIONS[setting.key].description
            }
          ]
        : []
    ),
    capabilities: capabilities.filter(({ code }) => CAPABILITY_CODE_VALUES.includes(code))
  };
}

export async function updateSystemSetting(
  command: UpdateSettingCommand,
  transaction?: Prisma.TransactionClient
) {
  const value = validateRuntimeSettingValue(command.key, command.value);
  const expectedVersion = validateVersion(command.version);
  const reason = validateReason(command.reason);

  return inTransaction(transaction, async (client) => {
    const current = await client.systemSetting.findUnique({ where: { key: command.key } });
    if (!current || !isRuntimeSettingKey(current.key)) {
      throw new ConfigurationValidationError("UNKNOWN_SETTING", "运行配置键不存在。", 404);
    }
    if (current.valueType !== SETTING_VALUE_TYPES.INTEGER) {
      throw new ConfigurationValidationError(
        "INVALID_VALUE",
        "运行配置注册类型与数据库类型不一致。",
        409
      );
    }

    const nextVersion = expectedVersion + 1;
    const updated = await client.systemSetting.updateMany({
      where: { key: current.key, version: expectedVersion },
      data: { value, version: nextVersion }
    });
    if (updated.count !== 1) {
      throw new ConfigurationValidationError(
        "VERSION_CONFLICT",
        "运行配置已发生变化，请刷新后重试。",
        409
      );
    }

    const setting = await client.systemSetting.findUniqueOrThrow({
      where: { key: current.key }
    });
    await client.systemSettingRevision.create({
      data: {
        settingKey: setting.key,
        version: setting.version,
        value,
        valueType: setting.valueType,
        changedById: command.actorId,
        changeReason: reason
      }
    });

    const context = { ...command.auditContext, actorId: command.actorId, reason };
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.CONFIGURATION_SETTING_CHANGED,
      objectType: AUDIT_OBJECT_TYPES.SYSTEM_SETTING,
      objectId: setting.key,
      context,
      before: {
        value: {
          key: current.key,
          value: current.value,
          valueType: current.valueType,
          version: current.version
        },
        allowedFields: SYSTEM_SETTING_AUDIT_FIELDS
      },
      after: {
        value: {
          key: setting.key,
          value: setting.value,
          valueType: setting.valueType,
          version: setting.version
        },
        allowedFields: SYSTEM_SETTING_AUDIT_FIELDS
      }
    });
    const event = await appendOutboxEvent(client, {
      eventType: "configuration.setting.changed",
      aggregateType: "SYSTEM_SETTING",
      aggregateId: setting.key,
      idempotencyKey: `${setting.key}:v${setting.version}`,
      payload: {
        key: setting.key,
        value: setting.value,
        valueType: setting.valueType,
        version: setting.version
      }
    });

    return { setting, auditId: audit.id, outboxEventId: event.id };
  });
}

export async function updateCompanyCapability(
  command: UpdateCapabilityCommand,
  transaction?: Prisma.TransactionClient
) {
  if (!isCapabilityCode(command.code)) {
    throw new ConfigurationValidationError("UNKNOWN_CAPABILITY", "公司能力代码不存在。", 404);
  }
  if (typeof command.enabled !== "boolean") {
    throw new ConfigurationValidationError("INVALID_VALUE", "enabled 必须是布尔值。", 422);
  }
  const enabled = command.enabled;
  const expectedVersion = validateVersion(command.version);
  const reason = validateReason(command.reason);

  return inTransaction(transaction, async (client) => {
    const current = await client.companyCapability.findUnique({
      where: { code: command.code }
    });
    if (!current) {
      throw new ConfigurationValidationError("UNKNOWN_CAPABILITY", "公司能力代码不存在。", 404);
    }

    const nextVersion = expectedVersion + 1;
    const updated = await client.companyCapability.updateMany({
      where: { code: command.code, version: expectedVersion },
      data: { enabled, version: nextVersion }
    });
    if (updated.count !== 1) {
      throw new ConfigurationValidationError(
        "VERSION_CONFLICT",
        "公司能力配置已发生变化，请刷新后重试。",
        409
      );
    }

    const capability = await client.companyCapability.findUniqueOrThrow({
      where: { code: command.code }
    });
    await client.companyCapabilityRevision.create({
      data: {
        capabilityCode: capability.code,
        version: capability.version,
        enabled: capability.enabled,
        changedById: command.actorId,
        changeReason: reason
      }
    });

    const context = { ...command.auditContext, actorId: command.actorId, reason };
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.COMPANY_CAPABILITY_CHANGED,
      objectType: AUDIT_OBJECT_TYPES.COMPANY_CAPABILITY,
      objectId: capability.code,
      context,
      before: {
        value: { code: current.code, enabled: current.enabled, version: current.version },
        allowedFields: COMPANY_CAPABILITY_AUDIT_FIELDS
      },
      after: {
        value: {
          code: capability.code,
          enabled: capability.enabled,
          version: capability.version
        },
        allowedFields: COMPANY_CAPABILITY_AUDIT_FIELDS
      }
    });
    const event = await appendOutboxEvent(client, {
      eventType: "configuration.company-capability.changed",
      aggregateType: "COMPANY_CAPABILITY",
      aggregateId: capability.code,
      idempotencyKey: `${capability.code}:v${capability.version}`,
      payload: {
        code: capability.code,
        enabled: capability.enabled,
        version: capability.version
      }
    });

    return { capability, auditId: audit.id, outboxEventId: event.id };
  });
}
