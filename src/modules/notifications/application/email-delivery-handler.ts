import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_SOURCES,
  NOTIFICATION_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import type { JobExecution, JobHandler } from "@/modules/governance/contracts/jobs";

import type { MailAdapter } from "../contracts/mail";

function deliveryId(job: JobExecution): string {
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
    throw new TypeError("邮件投递作业负载必须是对象。");
  }
  const value = (job.payload as Record<string, unknown>).deliveryId;
  if (typeof value !== "string" || !value) throw new TypeError("邮件投递作业缺少 deliveryId。");
  return value;
}

function auditContext(job: JobExecution, projectId: string | null): AuditContext {
  return {
    actorId: null,
    requestId: null,
    traceId: job.id,
    source: AUDIT_SOURCES.WORKER,
    sourceIp: null,
    userAgent: null,
    reason: null,
    projectId,
    departmentId: null,
    operationId: job.idempotencyKey
  };
}

async function databaseNow(transaction: Prisma.TransactionClient): Promise<Date> {
  const [row] = await transaction.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
  if (!row) throw new Error("无法读取数据库时间。");
  return row.now;
}

function failure(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    return {
      code: (error.name || "MAIL_DELIVERY_FAILED").slice(0, 191),
      message: (error.message || "邮件发送失败。").slice(0, 2048)
    };
  }
  return { code: "MAIL_DELIVERY_FAILED", message: "邮件发送失败。" };
}

export function createEmailDeliveryHandler(mail: MailAdapter): JobHandler {
  return async (job) => {
    const id = deliveryId(job);
    const delivery = await db.notificationDelivery.findUnique({
      where: { id },
      include: { notification: { include: { recipient: true } } }
    });
    if (!delivery) throw new Error("邮件投递作业引用的 Delivery 不存在。");
    if (delivery.status === "SENT") return;
    if (delivery.status === "DEAD_LETTER" && !job.isReplay) {
      throw new Error("邮件投递已进入 Dead Letter，必须授权重放。");
    }
    const recipientEmail = delivery.notification.recipient.email;
    if (!recipientEmail) throw new Error("通知接收人没有邮件地址。");

    await db.notificationDeliveryAttempt.createMany({
      data: {
        deliveryId: delivery.id,
        attemptNumber: job.attemptNumber,
        status: "RUNNING"
      },
      skipDuplicates: true
    });
    const existingAttempt = await db.notificationDeliveryAttempt.findUniqueOrThrow({
      where: {
        deliveryId_attemptNumber: {
          deliveryId: delivery.id,
          attemptNumber: job.attemptNumber
        }
      }
    });
    if (existingAttempt.status === "SENT") return;
    if (existingAttempt.status === "FAILED") {
      throw new Error("该邮件投递尝试已经失败，不能重复执行。");
    }

    try {
      const sent = await mail.send({
        to: recipientEmail,
        subject: delivery.notification.subject,
        text: delivery.notification.bodyText,
        html: delivery.notification.bodyHtml,
        idempotencyKey: delivery.idempotencyKey
      });
      await db.$transaction(async (transaction) => {
        const now = await databaseNow(transaction);
        const completed = await transaction.notificationDeliveryAttempt.updateMany({
          where: {
            deliveryId: delivery.id,
            attemptNumber: job.attemptNumber,
            status: "RUNNING"
          },
          data: {
            status: "SENT",
            completedAt: now,
            providerMessageId: sent.providerMessageId.slice(0, 512)
          }
        });
        if (completed.count === 0) return;
        const changed = await transaction.notificationDelivery.updateMany({
          where: { id: delivery.id, status: { not: "SENT" } },
          data: {
            status: "SENT",
            sentAt: now,
            providerMessageId: sent.providerMessageId.slice(0, 512),
            lastErrorCode: null,
            lastErrorMessage: null
          }
        });
        if (changed.count === 0) return;
        await writeAudit(transaction, {
          action: AUDIT_ACTIONS.NOTIFICATION_DELIVERED,
          objectType: AUDIT_OBJECT_TYPES.NOTIFICATION_DELIVERY,
          objectId: delivery.id,
          context: auditContext(job, delivery.notification.projectId),
          after: {
            value: {
              notificationId: delivery.notificationId,
              deliveryId: delivery.id,
              recipientId: delivery.notification.recipientId,
              projectId: delivery.notification.projectId,
              channel: delivery.channel,
              status: "SENT",
              attemptNumber: job.attemptNumber
            },
            allowedFields: NOTIFICATION_AUDIT_FIELDS
          }
        });
      });
    } catch (error) {
      const failed = failure(error);
      await db.$transaction(async (transaction) => {
        const now = await databaseNow(transaction);
        const completed = await transaction.notificationDeliveryAttempt.updateMany({
          where: {
            deliveryId: delivery.id,
            attemptNumber: job.attemptNumber,
            status: "RUNNING"
          },
          data: {
            status: "FAILED",
            completedAt: now,
            errorCode: failed.code,
            errorMessage: failed.message
          }
        });
        if (completed.count === 0) return;
        await transaction.notificationDelivery.updateMany({
          where: { id: delivery.id, status: { not: "SENT" } },
          data: {
            status: job.attemptNumber >= job.maxAttempts ? "DEAD_LETTER" : "RETRYING",
            lastErrorCode: failed.code,
            lastErrorMessage: failed.message
          }
        });
      });
      throw error;
    }
  };
}
