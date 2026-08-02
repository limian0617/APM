import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  NOTIFICATION_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";

import {
  NotificationValidationError,
  validateTemplateCode,
  validateTemplateDefinition
} from "../domain/notification-policy";

function version(value: unknown, allowZero = false): number {
  if (!Number.isInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
    throw new NotificationValidationError("INVALID_VERSION", "模板版本号无效。", 400);
  }
  return value as number;
}

function reason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new NotificationValidationError("REASON_REQUIRED", "变更原因必须是 1 到 1024 个字符。");
  }
  return value.trim();
}

export async function publishNotificationTemplate(input: {
  code: string;
  actorId: string;
  expectedVersion: unknown;
  subjectTemplate: unknown;
  bodyTextTemplate: unknown;
  bodyHtmlTemplate?: unknown;
  variableSchema: unknown;
  auditContext: AuditContext;
}) {
  const code = validateTemplateCode(input.code);
  const expectedVersion = version(input.expectedVersion, true);
  const definition = validateTemplateDefinition(input);

  return db.$transaction(async (transaction) => {
    let template = await transaction.notificationTemplate.findUnique({ where: { code } });
    let createdTemplate = false;
    if (!template) {
      if (expectedVersion !== 0) {
        throw new NotificationValidationError(
          "VERSION_CONFLICT",
          "通知模板已变化或尚不存在，请刷新后重试。",
          409
        );
      }
      template = await transaction.notificationTemplate.create({
        data: { code, currentVersion: 0, version: 1 }
      });
      createdTemplate = true;
    } else if (template.version !== expectedVersion) {
      throw new NotificationValidationError(
        "VERSION_CONFLICT",
        "通知模板已变化，请刷新后重试。",
        409
      );
    }

    const nextTemplateVersion = template.currentVersion + 1;
    const published = await transaction.notificationTemplateVersion.create({
      data: {
        templateCode: code,
        version: nextTemplateVersion,
        subjectTemplate: definition.subjectTemplate,
        bodyTextTemplate: definition.bodyTextTemplate,
        bodyHtmlTemplate: definition.bodyHtmlTemplate,
        variableSchema: definition.variableSchema as Prisma.InputJsonValue,
        publishedById: input.actorId
      }
    });
    const updated = await transaction.notificationTemplate.updateMany({
      where: { code, version: template.version },
      data: {
        currentVersion: nextTemplateVersion,
        ...(createdTemplate ? {} : { version: { increment: 1 } })
      }
    });
    if (updated.count !== 1) {
      throw new NotificationValidationError(
        "VERSION_CONFLICT",
        "通知模板已变化，请刷新后重试。",
        409
      );
    }
    const current = await transaction.notificationTemplate.findUniqueOrThrow({ where: { code } });
    const audit = await writeAudit(transaction, {
      action: AUDIT_ACTIONS.NOTIFICATION_TEMPLATE_PUBLISHED,
      objectType: AUDIT_OBJECT_TYPES.NOTIFICATION_TEMPLATE,
      objectId: code,
      context: { ...input.auditContext, actorId: input.actorId },
      after: {
        value: {
          templateCode: code,
          templateVersion: published.version,
          enabled: current.enabled,
          version: current.version
        },
        allowedFields: NOTIFICATION_AUDIT_FIELDS
      }
    });
    return { template: current, publishedVersion: published.version, auditId: audit.id };
  });
}

export async function setNotificationTemplateEnabled(input: {
  code: string;
  actorId: string;
  expectedVersion: unknown;
  enabled: unknown;
  reason: unknown;
  auditContext: AuditContext;
}) {
  const code = validateTemplateCode(input.code);
  const expectedVersion = version(input.expectedVersion);
  if (typeof input.enabled !== "boolean") {
    throw new NotificationValidationError("INVALID_ENABLED", "enabled 必须是布尔值。");
  }
  const enabled = input.enabled;
  const changeReason = reason(input.reason);

  return db.$transaction(async (transaction) => {
    const current = await transaction.notificationTemplate.findUnique({ where: { code } });
    if (!current) {
      throw new NotificationValidationError("TEMPLATE_NOT_FOUND", "通知模板不存在。", 404);
    }
    if (current.version !== expectedVersion) {
      throw new NotificationValidationError(
        "VERSION_CONFLICT",
        "通知模板已变化，请刷新后重试。",
        409
      );
    }
    if (current.enabled === enabled) return { template: current, repeated: true, auditId: null };
    const updated = await transaction.notificationTemplate.updateMany({
      where: { code, version: expectedVersion },
      data: { enabled, version: { increment: 1 } }
    });
    if (updated.count !== 1) {
      throw new NotificationValidationError("VERSION_CONFLICT", "通知模板已变化。", 409);
    }
    const template = await transaction.notificationTemplate.findUniqueOrThrow({ where: { code } });
    const audit = await writeAudit(transaction, {
      action: AUDIT_ACTIONS.NOTIFICATION_TEMPLATE_STATUS_CHANGED,
      objectType: AUDIT_OBJECT_TYPES.NOTIFICATION_TEMPLATE,
      objectId: code,
      context: {
        ...input.auditContext,
        actorId: input.actorId,
        reason: changeReason
      },
      before: {
        value: { templateCode: code, enabled: current.enabled, version: current.version },
        allowedFields: NOTIFICATION_AUDIT_FIELDS
      },
      after: {
        value: { templateCode: code, enabled: template.enabled, version: template.version },
        allowedFields: NOTIFICATION_AUDIT_FIELDS
      }
    });
    return { template, repeated: false, auditId: audit.id };
  });
}
