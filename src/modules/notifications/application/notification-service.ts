import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import type { AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS, PERMISSION_SCOPES } from "@/lib/auth/permissions";
import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_RESULTS,
  NOTIFICATION_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { payloadHash } from "@/modules/governance/domain/idempotency";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  NOTIFICATION_SENSITIVITIES,
  NotificationValidationError,
  renderNotificationTemplate,
  stableText,
  validateSensitivity,
  validateTargetPath,
  validateTemplateCode
} from "../domain/notification-policy";

type CreateNotificationCommand = {
  sourceEventKey: unknown;
  eventType: unknown;
  recipientId: unknown;
  projectId?: unknown;
  templateCode: unknown;
  variables: unknown;
  targetPath?: unknown;
  sensitivity?: unknown;
  sendEmail?: unknown;
  auditContext: AuditContext;
};

function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return stableText(value, field);
}

function notificationResponse(notification: {
  id: string;
  eventType: string;
  projectId: string | null;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  targetPath: string | null;
  sensitivity: string;
  createdAt: Date;
  readReceipt?: { readAt: Date } | null;
}) {
  return {
    id: notification.id,
    eventType: notification.eventType,
    projectId: notification.projectId,
    subject: notification.subject,
    bodyText: notification.bodyText,
    bodyHtml: notification.bodyHtml,
    targetPath: notification.targetPath,
    sensitivity: notification.sensitivity,
    createdAt: notification.createdAt,
    readAt: notification.readReceipt?.readAt ?? null
  };
}

export async function createNotification(command: CreateNotificationCommand) {
  const sourceEventKey = stableText(command.sourceEventKey, "sourceEventKey");
  const eventType = stableText(command.eventType, "eventType");
  const recipientId = stableText(command.recipientId, "recipientId");
  const projectId = optionalId(command.projectId, "projectId");
  const templateCode = validateTemplateCode(command.templateCode);
  const targetPath = validateTargetPath(command.targetPath);
  const sensitivity = validateSensitivity(command.sensitivity);
  if (command.sendEmail !== undefined && typeof command.sendEmail !== "boolean") {
    throw new NotificationValidationError("INVALID_CHANNEL", "sendEmail 必须是布尔值。");
  }
  const sendEmail = command.sendEmail === true;

  return db.$transaction(async (transaction) => {
    const [recipient, template] = await Promise.all([
      transaction.user.findUnique({ where: { id: recipientId } }),
      transaction.notificationTemplate.findUnique({ where: { code: templateCode } })
    ]);
    if (!recipient || recipient.status !== "ACTIVE") {
      throw new NotificationValidationError(
        "RECIPIENT_NOT_FOUND",
        "通知接收人不存在或已停用。",
        404
      );
    }
    if (projectId) {
      const project = await transaction.project.findUnique({
        where: { id: projectId },
        select: { id: true }
      });
      if (!project)
        throw new NotificationValidationError("PROJECT_NOT_FOUND", "通知项目不存在。", 404);
    }
    if (!template) {
      throw new NotificationValidationError("TEMPLATE_NOT_FOUND", "通知模板不存在。", 404);
    }
    if (!template.enabled) {
      throw new NotificationValidationError("TEMPLATE_DISABLED", "通知模板已停用。", 409);
    }
    if (template.currentVersion < 1) {
      throw new NotificationValidationError("TEMPLATE_NOT_PUBLISHED", "通知模板尚未发布。", 409);
    }
    const templateVersion = await transaction.notificationTemplateVersion.findUniqueOrThrow({
      where: {
        templateCode_version: { templateCode, version: template.currentVersion }
      }
    });
    const rendered = renderNotificationTemplate({
      subjectTemplate: templateVersion.subjectTemplate,
      bodyTextTemplate: templateVersion.bodyTextTemplate,
      bodyHtmlTemplate: templateVersion.bodyHtmlTemplate,
      variableSchema: templateVersion.variableSchema,
      variables: command.variables
    });
    if (!rendered.subject || rendered.subject.length > 998 || rendered.bodyText.length > 100_000) {
      throw new NotificationValidationError("RENDERED_TEMPLATE_INVALID", "通知渲染结果超出限制。");
    }
    if (sendEmail && !recipient.email) {
      throw new NotificationValidationError(
        "RECIPIENT_EMAIL_MISSING",
        "通知接收人没有邮件地址。",
        409
      );
    }
    const canonical = payloadHash({
      sourceEventKey,
      eventType,
      recipientId,
      projectId,
      templateCode,
      templateVersion: templateVersion.version,
      variables: command.variables,
      targetPath,
      sensitivity,
      sendEmail
    });
    const notificationId = randomUUID();
    const created = await transaction.notification.createMany({
      data: {
        id: notificationId,
        sourceEventKey,
        eventType,
        recipientId,
        projectId,
        templateVersionId: templateVersion.id,
        payloadHash: canonical.hash,
        subject: rendered.subject,
        bodyText: rendered.bodyText,
        bodyHtml: rendered.bodyHtml,
        targetPath,
        sensitivity
      },
      skipDuplicates: true
    });
    const notification = await transaction.notification.findUniqueOrThrow({
      where: { sourceEventKey_recipientId: { sourceEventKey, recipientId } }
    });
    if (notification.payloadHash !== canonical.hash) {
      throw new NotificationValidationError(
        "IDEMPOTENCY_KEY_REUSED",
        "相同来源事件和接收人已绑定到不同通知负载。",
        409
      );
    }
    if (created.count === 0) {
      return { notification: notificationResponse(notification), repeated: true, auditId: null };
    }

    let deliveryId: string | null = null;
    if (sendEmail) {
      deliveryId = randomUUID();
      const idempotencyKey = `notification-email:${payloadHash({ sourceEventKey, recipientId, channel: "EMAIL" }).hash}`;
      await transaction.notificationDelivery.create({
        data: {
          id: deliveryId,
          notificationId: notification.id,
          channel: "EMAIL",
          idempotencyKey
        }
      });
      await appendOutboxEvent(transaction, {
        eventType: "notification.email.requested",
        aggregateType: "NOTIFICATION_DELIVERY",
        aggregateId: deliveryId,
        idempotencyKey,
        payload: { deliveryId }
      });
    }
    const audit = await writeAudit(transaction, {
      action: AUDIT_ACTIONS.NOTIFICATION_CREATED,
      objectType: AUDIT_OBJECT_TYPES.NOTIFICATION,
      objectId: notification.id,
      context: { ...command.auditContext, projectId },
      after: {
        value: {
          notificationId: notification.id,
          deliveryId,
          sourceEventKey,
          eventType,
          recipientId,
          projectId,
          templateCode,
          templateVersion: templateVersion.version,
          sensitivity
        },
        allowedFields: NOTIFICATION_AUDIT_FIELDS
      }
    });
    return { notification: notificationResponse(notification), repeated: false, auditId: audit.id };
  });
}

async function sensitiveProjectIds(actor: AuthorizationActor): Promise<string[] | null> {
  const grants = actor.grants.filter(
    ({ permission }) => permission === PERMISSIONS.SENSITIVE_NOTIFICATION_READ
  );
  if (grants.some(({ scope }) => scope === PERMISSION_SCOPES.ALL)) return null;
  if (grants.length === 0) return [];
  const memberships = await db.projectMember.findMany({
    where: { userId: actor.id, leftAt: null },
    select: { projectId: true, departmentId: true }
  });
  const hasProject = grants.some(({ scope }) => scope === PERMISSION_SCOPES.PROJECT);
  const hasDepartment = grants.some(({ scope }) => scope === PERMISSION_SCOPES.DEPARTMENT);
  return memberships
    .filter(
      ({ departmentId }) => hasProject || (hasDepartment && departmentId === actor.departmentId)
    )
    .map(({ projectId }) => projectId);
}

export async function canReadSensitiveNotification(
  actor: AuthorizationActor,
  projectId: string | null
): Promise<boolean> {
  const projectIds = await sensitiveProjectIds(actor);
  return projectIds === null || (projectId !== null && projectIds.includes(projectId));
}

export async function recordNotificationDenial(input: {
  actorId: string;
  notificationId: string | null;
  context: AuditContext;
  reason: string;
  method: string;
  path: string;
}) {
  return writeAudit(db, {
    action: AUDIT_ACTIONS.AUTHORIZATION_DENIED,
    objectType: AUDIT_OBJECT_TYPES.NOTIFICATION,
    objectId: input.notificationId,
    result: AUDIT_RESULTS.DENIED,
    context: { ...input.context, actorId: input.actorId, reason: input.reason },
    metadata: {
      value: {
        notificationId: input.notificationId,
        permission: PERMISSIONS.NOTIFICATION_READ,
        method: input.method,
        path: input.path
      },
      allowedFields: NOTIFICATION_AUDIT_FIELDS
    }
  });
}

export async function listNotifications(input: {
  actor: AuthorizationActor;
  unreadOnly: boolean;
  cursor?: string | null;
  limit: number;
  auditContext: AuditContext;
}) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new NotificationValidationError("INVALID_LIMIT", "limit 必须在 1 到 100 之间。", 400);
  }
  const accessibleProjects = await sensitiveProjectIds(input.actor);
  let before: { createdAt: Date; id: string } | null = null;
  if (input.cursor) {
    const cursor = await db.notification.findFirst({
      where: { id: input.cursor, recipientId: input.actor.id },
      select: { id: true, createdAt: true }
    });
    if (!cursor) throw new NotificationValidationError("INVALID_CURSOR", "通知游标无效。", 400);
    before = cursor;
  }
  const items = await db.notification.findMany({
    where: {
      recipientId: input.actor.id,
      ...(input.unreadOnly ? { readReceipt: null } : {}),
      ...(accessibleProjects === null
        ? {}
        : {
            OR: [
              { sensitivity: NOTIFICATION_SENSITIVITIES.INTERNAL },
              {
                sensitivity: NOTIFICATION_SENSITIVITIES.RESTRICTED,
                projectId: { in: accessibleProjects }
              }
            ]
          }),
      ...(before
        ? {
            AND: [
              {
                OR: [
                  { createdAt: { lt: before.createdAt } },
                  { createdAt: before.createdAt, id: { lt: before.id } }
                ]
              }
            ]
          }
        : {})
    },
    include: { readReceipt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1
  });
  const hasMore = items.length > input.limit;
  const page = hasMore ? items.slice(0, input.limit) : items;
  const audit = await writeAudit(db, {
    action: AUDIT_ACTIONS.NOTIFICATION_INBOX_READ,
    objectType: AUDIT_OBJECT_TYPES.NOTIFICATION,
    context: { ...input.auditContext, actorId: input.actor.id },
    metadata: {
      value: {
        recipientId: input.actor.id,
        unreadOnly: input.unreadOnly,
        returnedCount: page.length
      },
      allowedFields: NOTIFICATION_AUDIT_FIELDS
    }
  });
  return {
    items: page.map(notificationResponse),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    auditId: audit.id
  };
}

export async function markNotificationRead(
  input: {
    notificationId: string;
    actor: AuthorizationActor;
    auditContext: AuditContext;
    method: string;
    path: string;
  },
  transaction?: Prisma.TransactionClient
) {
  const notification = await db.notification.findUnique({ where: { id: input.notificationId } });
  if (!notification || notification.recipientId !== input.actor.id) {
    await recordNotificationDenial({
      actorId: input.actor.id,
      notificationId: input.notificationId,
      context: input.auditContext,
      reason: "NOTIFICATION_NOT_FOUND_OR_UNRELATED",
      method: input.method,
      path: input.path
    });
    throw new NotificationValidationError("NOTIFICATION_NOT_FOUND", "通知不存在。", 404);
  }
  if (
    notification.sensitivity === NOTIFICATION_SENSITIVITIES.RESTRICTED &&
    !(await canReadSensitiveNotification(input.actor, notification.projectId))
  ) {
    await recordNotificationDenial({
      actorId: input.actor.id,
      notificationId: notification.id,
      context: input.auditContext,
      reason: "SENSITIVE_NOTIFICATION_FORBIDDEN",
      method: input.method,
      path: input.path
    });
    throw new NotificationValidationError("FORBIDDEN", "当前角色无权读取此通知。", 403);
  }

  return inTransaction(transaction, async (client) => {
    const created = await client.notificationReadReceipt.createMany({
      data: { notificationId: notification.id, recipientId: input.actor.id },
      skipDuplicates: true
    });
    const receipt = await client.notificationReadReceipt.findUniqueOrThrow({
      where: { notificationId: notification.id }
    });
    if (created.count === 0) return { readAt: receipt.readAt, repeated: true, auditId: null };
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.NOTIFICATION_MARKED_READ,
      objectType: AUDIT_OBJECT_TYPES.NOTIFICATION,
      objectId: notification.id,
      context: {
        ...input.auditContext,
        actorId: input.actor.id,
        projectId: notification.projectId
      },
      after: {
        value: {
          notificationId: notification.id,
          recipientId: input.actor.id,
          projectId: notification.projectId,
          sensitivity: notification.sensitivity
        },
        allowedFields: NOTIFICATION_AUDIT_FIELDS
      }
    });
    return { readAt: receipt.readAt, repeated: false, auditId: audit.id };
  });
}
