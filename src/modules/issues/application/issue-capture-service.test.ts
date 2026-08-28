import { describe, expect, it, vi } from "vitest";

import { createIssueCapture, createProjectIssue } from "./issue-service";

const now = new Date("2026-08-22T04:00:00.000Z");
const auditContext = {
  actorId: "user-1",
  requestId: "request-1",
  traceId: null,
  source: "API" as const,
  sourceIp: null,
  userAgent: null,
  reason: null,
  projectId: "project-1",
  departmentId: "department-1",
  operationId: "operation-1"
};
const actor = {
  id: "user-1",
  name: "现场工程师",
  status: "ACTIVE" as const,
  departmentId: "department-1",
  systemRoles: ["ENGINEER"],
  grants: []
};
const voiceFile = {
  id: "voice-1",
  projectId: "project-1",
  uploadedById: "user-1",
  originalName: "现场录音.m4a",
  declaredMimeType: "audio/mp4",
  verifiedMimeType: "audio/mp4",
  sha256: "a".repeat(64),
  status: "AVAILABLE",
  sensitivity: "INTERNAL"
};

function outbox() {
  return {
    upsert: vi.fn(async ({ create }) => ({ id: `outbox-${create.idempotencyKey}`, ...create }))
  };
}

function capture(status: "PENDING_CONFIRMATION" | "CONFIRMED" = "PENDING_CONFIRMATION") {
  return {
    id: "capture-1",
    projectId: "project-1",
    inputText: null,
    voiceFileId: "voice-1",
    voiceFileSha256: voiceFile.sha256,
    voiceFile,
    attachments: [],
    status,
    issueId: status === "CONFIRMED" ? "issue-1" : null,
    version: status === "CONFIRMED" ? 2 : 1,
    createdById: "user-1",
    createdAt: now,
    confirmedAt: status === "CONFIRMED" ? now : null
  };
}

function issue() {
  return {
    id: "issue-1",
    projectId: "project-1",
    title: "工位卡滞",
    confirmedText: "用户确认：定位销卡滞。",
    sourceType: "PROJECT",
    category: "FUNCTION",
    severity: "HIGH",
    phenomenonDescription: null,
    rootCauseCategory: null,
    rootCauseDescription: null,
    status: "PENDING_ACCEPTANCE",
    statusChangedAt: now,
    closedAt: null,
    closedById: null,
    verificationEvidence: null,
    ownerMembershipId: null,
    verifierMembershipId: null,
    dueDate: null,
    version: 1,
    createdById: "user-1",
    updatedById: "user-1",
    createdAt: now,
    updatedAt: now,
    ownerMembership: null,
    verifierMembership: null,
    tags: [],
    history: [],
    relations: []
  };
}

describe("APM-072 issue capture service", () => {
  it("stores a voice-only capture without creating a formal Issue", async () => {
    const issueCreate = vi.fn();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      project: { findUnique: vi.fn().mockResolvedValue({ id: "project-1", status: "ACTIVE" }) },
      fileObject: { findMany: vi.fn().mockResolvedValue([voiceFile]) },
      issueCapture: { create: vi.fn().mockResolvedValue(capture()) },
      issue: { create: issueCreate },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-capture" }) },
      outboxEvent: outbox()
    };

    const result = await createIssueCapture(
      {
        projectId: "project-1",
        voiceFileId: "voice-1",
        actorId: "user-1",
        fileAccess: { actor, projectDepartmentId: "department-1", memberRoles: ["ENGINEER"] },
        auditContext
      },
      transaction as never
    );

    expect(result.capture).toMatchObject({
      id: "capture-1",
      inputText: null,
      voiceFile: { id: "voice-1", sha256: voiceFile.sha256 },
      status: "PENDING_CONFIRMATION",
      issueId: null,
      version: 1
    });
    expect(issueCreate).not.toHaveBeenCalled();
  });

  it("creates the formal Issue only from user-confirmed text and consumes the exact capture version", async () => {
    const createdIssue = issue();
    const issueCreate = vi.fn().mockResolvedValue(createdIssue);
    const historyCreate = vi.fn().mockResolvedValue({ id: "history-1" });
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ now }]),
      project: { findUnique: vi.fn().mockResolvedValue({ id: "project-1", status: "ACTIVE" }) },
      fileObject: { findMany: vi.fn().mockResolvedValue([voiceFile]) },
      issueCapture: {
        findFirst: vi.fn().mockResolvedValue(capture()),
        update: vi.fn().mockResolvedValue(capture("CONFIRMED"))
      },
      issue: { create: issueCreate, findFirst: vi.fn().mockResolvedValue(createdIssue) },
      issueHistory: { count: vi.fn().mockResolvedValue(0), create: historyCreate },
      auditLog: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ id: "audit-issue" })
          .mockResolvedValueOnce({ id: "audit-capture" })
      },
      outboxEvent: outbox()
    };

    const result = await createProjectIssue(
      {
        projectId: "project-1",
        title: "工位卡滞",
        confirmedText: "用户确认：定位销卡滞。",
        category: "FUNCTION",
        severity: "HIGH",
        phenomenonDescription: null,
        rootCauseCategory: null,
        rootCauseDescription: null,
        tags: [],
        captureId: "capture-1",
        captureVersion: 1,
        actorId: "user-1",
        captureFileAccess: {
          actor,
          projectDepartmentId: "department-1",
          memberRoles: ["ENGINEER"]
        },
        auditContext
      },
      transaction as never
    );

    expect(issueCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ confirmedText: "用户确认：定位销卡滞。" })
      })
    );
    expect(transaction.issueCapture.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "CONFIRMED", issueId: "issue-1", version: { increment: 1 } }
      })
    );
    expect(historyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          snapshotJson: expect.objectContaining({
            confirmedText: "用户确认：定位销卡滞。",
            sourceSnapshot: expect.objectContaining({
              issueCapture: expect.objectContaining({
                captureId: "capture-1",
                captureVersion: 1,
                voiceFile: { id: "voice-1", sha256: voiceFile.sha256, mimeType: "audio/mp4" }
              })
            })
          })
        })
      })
    );
    expect(result).toMatchObject({
      issue: { id: "issue-1", confirmedText: "用户确认：定位销卡滞。" },
      capture: { id: "capture-1", status: "CONFIRMED", issueId: "issue-1", version: 2 },
      auditId: "audit-issue",
      captureAuditId: "audit-capture"
    });
  });

  it("derives a captured Issue description only from the user-confirmed text", async () => {
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ now }]),
      project: { findUnique: vi.fn().mockResolvedValue({ id: "project-1", status: "ACTIVE" }) },
      fileObject: { findMany: vi.fn().mockResolvedValue([voiceFile]) },
      issueCapture: {
        findFirst: vi.fn().mockResolvedValue(capture()),
        update: vi.fn().mockResolvedValue(capture("CONFIRMED"))
      },
      issue: {
        create: vi.fn().mockResolvedValue(issue()),
        findFirst: vi.fn().mockResolvedValue(issue())
      },
      issueHistory: { count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      outboxEvent: outbox()
    };

    await createProjectIssue(
      {
        projectId: "project-1",
        title: "工位卡滞",
        confirmedText: "用户确认：定位销卡滞。",
        category: "FUNCTION",
        severity: "HIGH",
        phenomenonDescription: "客户端不得把未确认转写写入正式问题。",
        rootCauseCategory: null,
        rootCauseDescription: null,
        tags: [],
        captureId: "capture-1",
        captureVersion: 1,
        actorId: "user-1",
        captureFileAccess: {
          actor,
          projectDepartmentId: "department-1",
          memberRoles: ["ENGINEER"]
        },
        auditContext
      },
      transaction as never
    );

    expect(transaction.issue.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phenomenonDescription: "用户确认：定位销卡滞。" })
      })
    );
  });

  it("default-denies unavailable and cross-project voice files", async () => {
    const base = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      project: { findUnique: vi.fn().mockResolvedValue({ id: "project-1", status: "ACTIVE" }) },
      issueCapture: { create: vi.fn() },
      auditLog: { create: vi.fn() },
      outboxEvent: outbox()
    };
    await expect(
      createIssueCapture(
        {
          projectId: "project-1",
          voiceFileId: "voice-1",
          actorId: "user-1",
          auditContext
        },
        { ...base, fileObject: { findMany: vi.fn().mockResolvedValue([]) } } as never
      )
    ).rejects.toMatchObject({ code: "ISSUE_CAPTURE_FILE_NOT_FOUND", status: 404 });
    await expect(
      createIssueCapture(
        {
          projectId: "project-1",
          voiceFileId: "voice-1",
          actorId: "user-1",
          auditContext
        },
        {
          ...base,
          fileObject: {
            findMany: vi.fn().mockResolvedValue([{ ...voiceFile, status: "PENDING_SCAN" }])
          }
        } as never
      )
    ).rejects.toMatchObject({ code: "ISSUE_CAPTURE_FILE_NOT_AVAILABLE", status: 409 });
  });
});
