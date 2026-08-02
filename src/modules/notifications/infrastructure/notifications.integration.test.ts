import { randomUUID } from "node:crypto";

import { ProjectRole } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";

import { POST as markReadRoute } from "@/app/api/notifications/[notificationId]/read/route";
import { GET as inboxRoute } from "@/app/api/notifications/route";
import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import { createEmailDeliveryHandler } from "@/modules/notifications/application/email-delivery-handler";
import {
  createNotification,
  markNotificationRead
} from "@/modules/notifications/application/notification-service";
import {
  publishNotificationTemplate,
  setNotificationTemplateEnabled
} from "@/modules/notifications/application/notification-template-service";
import type { MailAdapter } from "@/modules/notifications/contracts/mail";
import { MemoryMailAdapter } from "@/modules/notifications/infrastructure/memory-mail-adapter";
import type { JobExecution } from "@/modules/governance/contracts/jobs";
import { payloadHash } from "@/modules/governance/domain/idempotency";
import { loadAuthorizationActor } from "@/lib/auth/repository";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `notifications-admin-${suffix}`,
  engineer: `notifications-engineer-${suffix}`,
  other: `notifications-other-${suffix}`,
  project: `notifications-project-${suffix}`
};

function context(
  actorId: string | null,
  operationId: string,
  projectId: string | null = null
): AuditContext {
  return {
    actorId,
    requestId: `request-${operationId}`,
    traceId: `trace-${operationId}`,
    source: "SYSTEM",
    sourceIp: null,
    userAgent: "Vitest",
    reason: null,
    projectId,
    departmentId: projectId ? "engineering" : null,
    operationId
  };
}

async function actor(userId: string) {
  const value = await loadAuthorizationActor(userId);
  if (!value) throw new Error(`Missing notification actor ${userId}`);
  return value;
}

async function genericNotification(input?: {
  recipientId?: string;
  sourceEventKey?: string;
  sensitivity?: string;
  sendEmail?: boolean;
  title?: string;
  message?: string;
}) {
  const recipientId = input?.recipientId ?? ids.engineer;
  const sourceEventKey = input?.sourceEventKey ?? `notification-event-${randomUUID()}`;
  return createNotification({
    sourceEventKey,
    eventType: "test.notification.created",
    recipientId,
    projectId: ids.project,
    templateCode: "SYSTEM.GENERIC",
    variables: {
      title: input?.title ?? `Title ${sourceEventKey}`,
      message: input?.message ?? `Message ${sourceEventKey}`
    },
    targetPath: `/projects/${ids.project}`,
    sensitivity: input?.sensitivity,
    sendEmail: input?.sendEmail,
    auditContext: context(null, `create-${sourceEventKey}`, ids.project)
  });
}

function deliveryJob(
  deliveryId: string,
  input: Partial<Pick<JobExecution, "attemptNumber" | "maxAttempts" | "isReplay">> = {}
): JobExecution {
  const payload = { deliveryId };
  const attemptNumber = input.attemptNumber ?? 1;
  return {
    id: `notification-job-${deliveryId}`,
    jobType: "notification.email.requested",
    payload,
    payloadHash: payloadHash(payload).hash,
    idempotencyKey: `notification-delivery:${deliveryId}`,
    attemptId: `notification-attempt-${deliveryId}-${attemptNumber}`,
    attemptNumber,
    maxAttempts: input.maxAttempts ?? 3,
    isReplay: input.isReplay ?? false,
    workerId: `notification-worker-${suffix}`
  };
}

describeDatabase("APM-006 PostgreSQL notifications", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `NOTIFY-ADMIN-${suffix}`,
          name: "通知管理员",
          email: `notify-admin-${suffix}@example.com`,
          departmentId: "hq"
        },
        {
          id: ids.engineer,
          employeeNo: `NOTIFY-ENG-${suffix}`,
          name: "通知工程师",
          email: `notify-engineer-${suffix}@example.com`,
          departmentId: "engineering"
        },
        {
          id: ids.other,
          employeeNo: `NOTIFY-OTHER-${suffix}`,
          name: "其他工程师",
          email: `notify-other-${suffix}@example.com`,
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `notify-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        { id: `notify-role-engineer-${suffix}`, userId: ids.engineer, roleId: "role-engineer" },
        { id: `notify-role-other-${suffix}`, userId: ids.other, roleId: "role-engineer" }
      ]
    });
    await db.project.create({
      data: {
        id: ids.project,
        code: `NOTIFY-${suffix}`,
        name: "通知测试项目",
        departmentId: "engineering",
        createdById: ids.admin
      }
    });
    await db.projectMember.createMany({
      data: [
        {
          id: `notify-member-engineer-${suffix}`,
          projectId: ids.project,
          userId: ids.engineer,
          projectRole: ProjectRole.ENGINEER,
          departmentId: "engineering",
          assignedById: ids.admin
        },
        {
          id: `notify-member-other-${suffix}`,
          projectId: ids.project,
          userId: ids.other,
          projectRole: ProjectRole.ENGINEER,
          departmentId: "engineering",
          assignedById: ids.admin
        }
      ]
    });
  });

  it("publishes immutable versions and freezes rendered notification content", async () => {
    const code = `TEST.FREEZE.${suffix.toUpperCase()}`;
    const first = await publishNotificationTemplate({
      code,
      actorId: ids.admin,
      expectedVersion: 0,
      subjectTemplate: "V1 {{name}}",
      bodyTextTemplate: "First {{name}}",
      variableSchema: { name: { type: "string", required: true } },
      auditContext: context(ids.admin, `template-v1-${suffix}`)
    });
    expect(first).toMatchObject({
      template: { version: 1, currentVersion: 1 },
      publishedVersion: 1
    });
    const notification = await createNotification({
      sourceEventKey: `freeze-${suffix}`,
      eventType: "test.freeze",
      recipientId: ids.engineer,
      projectId: ids.project,
      templateCode: code,
      variables: { name: "Alice" },
      auditContext: context(null, `freeze-${suffix}`, ids.project)
    });
    const second = await publishNotificationTemplate({
      code,
      actorId: ids.admin,
      expectedVersion: 1,
      subjectTemplate: "V2 {{name}}",
      bodyTextTemplate: "Second {{name}}",
      variableSchema: { name: { type: "string", required: true } },
      auditContext: context(ids.admin, `template-v2-${suffix}`)
    });
    expect(second).toMatchObject({
      template: { version: 2, currentVersion: 2 },
      publishedVersion: 2
    });
    await expect(
      db.notification.findUniqueOrThrow({ where: { id: notification.notification.id } })
    ).resolves.toMatchObject({ subject: "V1 Alice", bodyText: "First Alice" });
    const versionOne = await db.notificationTemplateVersion.findUniqueOrThrow({
      where: { templateCode_version: { templateCode: code, version: 1 } }
    });
    await expect(
      db.notificationTemplateVersion.update({
        where: { id: versionOne.id },
        data: { subjectTemplate: "mutated" }
      })
    ).rejects.toThrow(/immutable/);
    await expect(
      db.notification.update({
        where: { id: notification.notification.id },
        data: { subject: "mutated" }
      })
    ).rejects.toThrow(/immutable/);
  });

  it("rejects disabled templates and idempotency-key payload conflicts", async () => {
    const code = `TEST.DISABLED.${suffix.toUpperCase()}`;
    const published = await publishNotificationTemplate({
      code,
      actorId: ids.admin,
      expectedVersion: 0,
      subjectTemplate: "{{title}}",
      bodyTextTemplate: "{{message}}",
      variableSchema: {
        title: { type: "string", required: true },
        message: { type: "string", required: true }
      },
      auditContext: context(ids.admin, `disabled-publish-${suffix}`)
    });
    await setNotificationTemplateEnabled({
      code,
      actorId: ids.admin,
      expectedVersion: published.template.version,
      enabled: false,
      reason: "验证停用模板",
      auditContext: context(ids.admin, `disabled-status-${suffix}`)
    });
    await expect(
      createNotification({
        sourceEventKey: `disabled-${suffix}`,
        eventType: "test.disabled",
        recipientId: ids.engineer,
        templateCode: code,
        variables: { title: "T", message: "M" },
        auditContext: context(null, `disabled-create-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "TEMPLATE_DISABLED", status: 409 });

    const sourceEventKey = `idempotent-${suffix}`;
    const first = await genericNotification({ sourceEventKey, sendEmail: true });
    const repeated = await genericNotification({ sourceEventKey, sendEmail: true });
    expect(first.repeated).toBe(false);
    expect(repeated).toMatchObject({ repeated: true, notification: { id: first.notification.id } });
    await expect(
      genericNotification({ sourceEventKey, sendEmail: true, message: "different payload" })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
    await expect(
      db.notificationDelivery.count({ where: { notificationId: first.notification.id } })
    ).resolves.toBe(1);
    await expect(
      db.outboxEvent.count({
        where: { eventType: "notification.email.requested", aggregateId: { not: null } }
      })
    ).resolves.toBeGreaterThanOrEqual(1);
  });

  it("isolates inboxes, sensitive notifications, IDOR attempts, and immutable first-read facts", async () => {
    const own = await genericNotification({ title: `OWN-${suffix}` });
    const other = await genericNotification({ recipientId: ids.other, title: `OTHER-${suffix}` });
    const sensitive = await genericNotification({
      title: `SENSITIVE-${suffix}`,
      sensitivity: "RESTRICTED"
    });
    const inbox = await inboxRoute(
      new Request("http://localhost/api/notifications?unread=true", {
        headers: { "x-apm-user-id": ids.engineer, "x-request-id": `inbox-${suffix}` }
      })
    );
    expect(inbox.status).toBe(200);
    const body = (await inbox.json()) as { items: Array<{ id: string }> };
    expect(body.items.map(({ id }) => id)).toContain(own.notification.id);
    expect(body.items.map(({ id }) => id)).not.toContain(other.notification.id);
    expect(body.items.map(({ id }) => id)).not.toContain(sensitive.notification.id);

    const firstRead = await markReadRoute(
      new Request(`http://localhost/api/notifications/${own.notification.id}/read`, {
        method: "POST",
        headers: {
          "x-apm-user-id": ids.engineer,
          "x-request-id": `read-one-${suffix}`,
          "idempotency-key": `read-one-${suffix}`
        }
      }),
      { params: Promise.resolve({ notificationId: own.notification.id }) }
    );
    const repeatedRead = await markReadRoute(
      new Request(`http://localhost/api/notifications/${own.notification.id}/read`, {
        method: "POST",
        headers: {
          "x-apm-user-id": ids.engineer,
          "x-request-id": `read-two-${suffix}`,
          "idempotency-key": `read-two-${suffix}`
        }
      }),
      { params: Promise.resolve({ notificationId: own.notification.id }) }
    );
    expect(firstRead.status).toBe(200);
    expect(repeatedRead.status).toBe(200);
    const firstBody = (await firstRead.json()) as { readAt: string; repeated: boolean };
    const repeatedBody = (await repeatedRead.json()) as { readAt: string; repeated: boolean };
    expect(firstBody.repeated).toBe(false);
    expect(repeatedBody).toEqual({ readAt: firstBody.readAt, repeated: true, auditId: null });
    const receipt = await db.notificationReadReceipt.findUniqueOrThrow({
      where: { notificationId: own.notification.id }
    });
    await expect(
      db.notificationReadReceipt.update({
        where: { id: receipt.id },
        data: { readAt: new Date() }
      })
    ).rejects.toThrow(/immutable/);

    const idor = await markReadRoute(
      new Request(`http://localhost/api/notifications/${other.notification.id}/read`, {
        method: "POST",
        headers: {
          "x-apm-user-id": ids.engineer,
          "x-request-id": `read-idor-${suffix}`,
          "idempotency-key": `read-idor-${suffix}`
        }
      }),
      { params: Promise.resolve({ notificationId: other.notification.id }) }
    );
    expect(idor.status).toBe(404);
    const deniedSensitive = await markNotificationRead({
      notificationId: sensitive.notification.id,
      actor: await actor(ids.engineer),
      auditContext: context(ids.engineer, `read-sensitive-${suffix}`, ids.project),
      method: "POST",
      path: `/api/notifications/${sensitive.notification.id}/read`
    }).catch((error: unknown) => error);
    expect(deniedSensitive).toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(
      db.auditLog.count({
        where: {
          action: "AUTHORIZATION_DENIED",
          objectType: "NOTIFICATION",
          objectId: { in: [other.notification.id, sensitive.notification.id] }
        }
      })
    ).resolves.toBeGreaterThanOrEqual(2);
  });

  it("deduplicates successful email and records retries, Dead Letter, and replay history", async () => {
    const successful = await genericNotification({ sendEmail: true, title: `EMAIL-OK-${suffix}` });
    const delivery = await db.notificationDelivery.findFirstOrThrow({
      where: { notificationId: successful.notification.id }
    });
    const mail = new MemoryMailAdapter();
    const observedStatuses: string[] = [];
    const observingMail: MailAdapter = {
      async send(message) {
        const attempt = await db.notificationDeliveryAttempt.findUniqueOrThrow({
          where: {
            deliveryId_attemptNumber: { deliveryId: delivery.id, attemptNumber: 1 }
          }
        });
        observedStatuses.push(attempt.status);
        return mail.send(message);
      }
    };
    const handler = createEmailDeliveryHandler(observingMail);
    const job = deliveryJob(delivery.id);
    await handler(job);
    await handler(job);
    expect(mail.sentCount).toBe(1);
    expect(observedStatuses).toEqual(["RUNNING"]);
    await expect(
      db.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })
    ).resolves.toMatchObject({ status: "SENT", providerMessageId: "memory-1" });
    await expect(
      db.notificationDeliveryAttempt.count({ where: { deliveryId: delivery.id } })
    ).resolves.toBe(1);

    const failed = await genericNotification({ sendEmail: true, title: `EMAIL-FAIL-${suffix}` });
    const failedDelivery = await db.notificationDelivery.findFirstOrThrow({
      where: { notificationId: failed.notification.id }
    });
    const unavailable: MailAdapter = {
      async send() {
        throw new Error("SMTP unavailable");
      }
    };
    const failingHandler = createEmailDeliveryHandler(unavailable);
    await expect(
      failingHandler(deliveryJob(failedDelivery.id, { attemptNumber: 1, maxAttempts: 2 }))
    ).rejects.toThrow("SMTP unavailable");
    await expect(
      db.notificationDelivery.findUniqueOrThrow({ where: { id: failedDelivery.id } })
    ).resolves.toMatchObject({ status: "RETRYING" });
    await expect(
      failingHandler(deliveryJob(failedDelivery.id, { attemptNumber: 2, maxAttempts: 2 }))
    ).rejects.toThrow("SMTP unavailable");
    await expect(
      db.notificationDelivery.findUniqueOrThrow({ where: { id: failedDelivery.id } })
    ).resolves.toMatchObject({ status: "DEAD_LETTER" });

    const recoveredMail = new MemoryMailAdapter();
    await createEmailDeliveryHandler(recoveredMail)(
      deliveryJob(failedDelivery.id, { attemptNumber: 3, maxAttempts: 2, isReplay: true })
    );
    await expect(
      db.notificationDelivery.findUniqueOrThrow({ where: { id: failedDelivery.id } })
    ).resolves.toMatchObject({ status: "SENT" });
    const attempts = await db.notificationDeliveryAttempt.findMany({
      where: { deliveryId: failedDelivery.id },
      orderBy: { attemptNumber: "asc" }
    });
    expect(attempts.map(({ status }) => status)).toEqual(["FAILED", "FAILED", "SENT"]);
    await expect(
      db.notificationDeliveryAttempt.update({
        where: { id: attempts[0]!.id },
        data: { errorMessage: "mutated" }
      })
    ).rejects.toThrow(/immutable/);
  });
});
