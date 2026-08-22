import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";

import { createIssueCapture, createProjectIssue } from "../application/issue-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const actorId = `apm072-engineer-${suffix}`;

function auditContext(operationId: string, projectId: string): AuditContext {
  return {
    actorId,
    requestId: `request-${operationId}`,
    traceId: null,
    source: "API",
    sourceIp: null,
    userAgent: "Vitest",
    reason: null,
    projectId,
    departmentId: "engineering",
    operationId
  };
}

const actor = {
  id: actorId,
  name: "APM-072 field engineer",
  status: "ACTIVE" as const,
  departmentId: "engineering",
  systemRoles: ["ENGINEER"],
  grants: []
};

describeDatabase("APM-072 PostgreSQL mobile issue captures", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: actorId,
        employeeNo: `APM072-${suffix}`,
        name: actor.name,
        departmentId: "engineering"
      }
    });
  });

  it("keeps voice pending without an Issue, then atomically confirms one user-text fact", async () => {
    const project = await db.project.create({
      data: {
        code: `APM072.CAPTURE.${suffix}`.toUpperCase(),
        name: "APM-072 capture",
        departmentId: "engineering",
        createdById: actorId
      }
    });
    const voice = await db.fileObject.create({
      data: {
        projectId: project.id,
        uploadedById: actorId,
        originalName: "现场录音.m4a",
        declaredMimeType: "audio/mp4",
        verifiedMimeType: "audio/mp4",
        declaredSize: 128n,
        verifiedSize: 128n,
        sha256: "a".repeat(64),
        objectKey: randomUUID(),
        storageArea: "CONTROLLED",
        status: "AVAILABLE",
        sensitivity: "INTERNAL",
        scannedAt: new Date()
      }
    });
    const created = await createIssueCapture({
      projectId: project.id,
      voiceFileId: voice.id,
      actorId,
      fileAccess: { actor, projectDepartmentId: "engineering", memberRoles: ["ENGINEER"] },
      auditContext: auditContext("capture-create", project.id)
    });

    expect(created.capture).toMatchObject({
      status: "PENDING_CONFIRMATION",
      issueId: null,
      voiceFile: { id: voice.id, sha256: voice.sha256 }
    });
    await expect(db.issue.count({ where: { projectId: project.id } })).resolves.toBe(0);

    const confirmedText = "用户确认：定位销伸出后与夹具卡滞。";
    const confirmed = await createProjectIssue({
      projectId: project.id,
      title: "定位销卡滞",
      confirmedText,
      category: "FUNCTION",
      severity: "HIGH",
      phenomenonDescription: "客户端传入的未确认文字不得成为正式问题事实。",
      rootCauseCategory: null,
      rootCauseDescription: null,
      tags: [],
      captureId: created.capture.id,
      captureVersion: created.capture.version,
      actorId,
      captureFileAccess: {
        actor,
        projectDepartmentId: "engineering",
        memberRoles: ["ENGINEER"]
      },
      auditContext: auditContext("capture-confirm", project.id)
    });

    expect(confirmed.issue.confirmedText).toBe(confirmedText);
    expect(confirmed.issue.phenomenonDescription).toBe(confirmedText);
    expect(confirmed.capture).toMatchObject({
      id: created.capture.id,
      status: "CONFIRMED",
      issueId: confirmed.issue.id,
      version: 2
    });
    await expect(
      db.issueHistory.findFirstOrThrow({ where: { issueId: confirmed.issue.id } })
    ).resolves.toMatchObject({
      snapshotJson: expect.objectContaining({
        confirmedText,
        sourceSnapshot: expect.objectContaining({
          issueCapture: expect.objectContaining({ captureId: created.capture.id })
        })
      })
    });
    await expect(
      db.auditLog.count({
        where: {
          objectId: { in: [created.capture.id, confirmed.issue.id] },
          result: "SUCCESS"
        }
      })
    ).resolves.toBe(3);
    await expect(
      db.outboxEvent.count({
        where: { aggregateId: { in: [created.capture.id, confirmed.issue.id] } }
      })
    ).resolves.toBe(3);
    await expect(
      db.$executeRaw`UPDATE "issue_captures" SET "input_text" = 'forbidden' WHERE "id" = ${created.capture.id}`
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`DELETE FROM "issue_captures" WHERE "id" = ${created.capture.id}`
    ).rejects.toThrow();
  });

  it("serializes two confirmation commands so only one formal Issue can commit", async () => {
    const project = await db.project.create({
      data: {
        code: `APM072.RACE.${suffix}`.toUpperCase(),
        name: "APM-072 race",
        departmentId: "engineering",
        createdById: actorId
      }
    });
    const capture = await createIssueCapture({
      projectId: project.id,
      inputText: "现场文字草稿",
      actorId,
      auditContext: auditContext("race-capture", project.id)
    });
    const submit = (operation: string) =>
      createProjectIssue({
        projectId: project.id,
        title: "并发确认",
        confirmedText: "用户确认的唯一事实。",
        category: "FUNCTION",
        severity: "MEDIUM",
        phenomenonDescription: null,
        rootCauseCategory: null,
        rootCauseDescription: null,
        tags: [],
        captureId: capture.capture.id,
        captureVersion: 1,
        actorId,
        auditContext: auditContext(operation, project.id)
      });

    const results = await Promise.allSettled([submit("race-a"), submit("race-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ code: "ISSUE_CAPTURE_ALREADY_CONFIRMED", status: 409 })
    });
    await expect(db.issue.count({ where: { projectId: project.id } })).resolves.toBe(1);
    await expect(
      db.issueCapture.findUniqueOrThrow({ where: { id: capture.capture.id } })
    ).resolves.toMatchObject({ status: "CONFIRMED", version: 2 });
  });

  it("rejects direct cross-project or non-exact media attachment writes", async () => {
    const project = await db.project.create({
      data: {
        code: `APM072.MEDIA.${suffix}`.toUpperCase(),
        name: "APM-072 media",
        departmentId: "engineering",
        createdById: actorId
      }
    });
    const otherProject = await db.project.create({
      data: {
        code: `APM072.OTHER.${suffix}`.toUpperCase(),
        name: "APM-072 other",
        departmentId: "engineering",
        createdById: actorId
      }
    });
    const media = await db.fileObject.create({
      data: {
        projectId: project.id,
        uploadedById: actorId,
        originalName: "现场照片.jpg",
        declaredMimeType: "image/jpeg",
        verifiedMimeType: "image/jpeg",
        declaredSize: 64n,
        verifiedSize: 64n,
        sha256: "b".repeat(64),
        objectKey: randomUUID(),
        storageArea: "CONTROLLED",
        status: "AVAILABLE",
        sensitivity: "INTERNAL",
        scannedAt: new Date()
      }
    });
    const capture = await createIssueCapture({
      projectId: project.id,
      inputText: "文字录入并附现场照片",
      actorId,
      auditContext: auditContext("media-capture", project.id)
    });
    const attachmentId = randomUUID();
    await expect(
      db.$executeRaw`
        INSERT INTO "issue_capture_attachments"
          ("id", "project_id", "capture_id", "file_id", "file_sha256")
        VALUES (${attachmentId}, ${project.id}, ${capture.capture.id}, ${media.id}, ${"c".repeat(64)})
      `
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`
        INSERT INTO "issue_capture_attachments"
          ("id", "project_id", "capture_id", "file_id", "file_sha256")
        VALUES (${attachmentId}, ${otherProject.id}, ${capture.capture.id}, ${media.id}, ${media.sha256})
      `
    ).rejects.toThrow();
    await db.$executeRaw`
      INSERT INTO "issue_capture_attachments"
        ("id", "project_id", "capture_id", "file_id", "file_sha256")
      VALUES (${attachmentId}, ${project.id}, ${capture.capture.id}, ${media.id}, ${media.sha256})
    `;
    await expect(
      db.$executeRaw`UPDATE "issue_capture_attachments" SET "file_sha256" = ${"d".repeat(64)} WHERE "id" = ${attachmentId}`
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`DELETE FROM "issue_captures" WHERE "id" = ${capture.capture.id}`
    ).rejects.toThrow();
  });

  it("rejects direct confirmed inserts and Issue bindings that bypass user-confirmed facts", async () => {
    const project = await db.project.create({
      data: {
        code: `APM072.CONFIRM.GUARD.${suffix}`.toUpperCase(),
        name: "APM-072 confirmation guard",
        departmentId: "engineering",
        createdById: actorId
      }
    });
    const confirmedIssue = await createProjectIssue({
      projectId: project.id,
      title: "正式问题",
      confirmedText: "用户确认的正式问题文字。",
      category: "FUNCTION",
      severity: "MEDIUM",
      phenomenonDescription: "与用户确认文字不一致的旧问题描述。",
      rootCauseCategory: null,
      rootCauseDescription: null,
      tags: [],
      actorId,
      auditContext: auditContext("confirmation-guard-issue", project.id)
    });
    const directlyConfirmedCaptureId = randomUUID();

    await expect(
      db.$executeRaw`
        INSERT INTO "issue_captures"
          ("id", "project_id", "input_text", "status", "issue_id", "version", "created_by_id", "confirmed_at")
        VALUES
          (${directlyConfirmedCaptureId}, ${project.id}, ${"直接确认绕过"}, 'CONFIRMED', ${confirmedIssue.issue.id}, 1, ${actorId}, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      `
    ).rejects.toMatchObject({ code: "P2010", meta: expect.objectContaining({ code: "23514" }) });
    await expect(
      db.issueCapture.findUnique({ where: { id: directlyConfirmedCaptureId } })
    ).resolves.toBeNull();

    const pending = await createIssueCapture({
      projectId: project.id,
      inputText: "等待用户确认的文字。",
      actorId,
      auditContext: auditContext("confirmation-guard-pending", project.id)
    });
    await expect(
      db.$executeRaw`
        UPDATE "issue_captures"
        SET "status" = 'CONFIRMED', "issue_id" = ${confirmedIssue.issue.id}, "version" = 2
        WHERE "id" = ${pending.capture.id} AND "project_id" = ${project.id}
      `
    ).rejects.toMatchObject({ code: "P2010", meta: expect.objectContaining({ code: "23514" }) });
    await expect(
      db.issueCapture.findUniqueOrThrow({ where: { id: pending.capture.id } })
    ).resolves.toMatchObject({
      status: "PENDING_CONFIRMATION",
      issueId: null,
      version: 1,
      confirmedAt: null
    });

    const media = await db.fileObject.create({
      data: {
        projectId: project.id,
        uploadedById: actorId,
        originalName: "时间戳证据.jpg",
        declaredMimeType: "image/jpeg",
        verifiedMimeType: "image/jpeg",
        declaredSize: 64n,
        verifiedSize: 64n,
        sha256: "e".repeat(64),
        objectKey: randomUUID(),
        storageArea: "CONTROLLED",
        status: "AVAILABLE",
        sensitivity: "INTERNAL",
        scannedAt: new Date()
      }
    });
    const forcedAt = new Date("2000-01-01T00:00:00.000Z");
    const pendingDirectId = randomUUID();
    await db.$executeRaw`
      INSERT INTO "issue_captures"
        ("id", "project_id", "input_text", "status", "version", "created_by_id", "created_at")
      VALUES
        (${pendingDirectId}, ${project.id}, ${"数据库时间不可伪造。"}, 'PENDING_CONFIRMATION', 1, ${actorId}, ${forcedAt})
    `;
    const attachmentId = randomUUID();
    await db.$executeRaw`
      INSERT INTO "issue_capture_attachments"
        ("id", "project_id", "capture_id", "file_id", "file_sha256", "created_at")
      VALUES
        (${attachmentId}, ${project.id}, ${pendingDirectId}, ${media.id}, ${media.sha256}, ${forcedAt})
    `;
    const timestampedCapture = await db.issueCapture.findUniqueOrThrow({
      where: { id: pendingDirectId }
    });
    const timestampedAttachment = await db.issueCaptureAttachment.findFirstOrThrow({
      where: { id: attachmentId }
    });
    expect(timestampedCapture.createdAt.getTime()).not.toBe(forcedAt.getTime());
    expect(timestampedAttachment.createdAt.getTime()).not.toBe(forcedAt.getTime());
  });
});
