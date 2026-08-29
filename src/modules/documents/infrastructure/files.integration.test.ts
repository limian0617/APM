import { createHash, randomUUID } from "node:crypto";

import { JobAttemptStatus, JobStatus, ProjectRole } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";

import { loadAuthorizationActor } from "@/lib/auth/repository";
import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import { createDownloadHandler } from "@/app/api/projects/[projectId]/files/[fileId]/download/route";
import {
  completeFileUpload,
  createUploadPartUrl,
  startFileUpload
} from "@/modules/documents/application/file-upload-service";
import { createFileScanHandler } from "@/modules/documents/application/file-scan-handler";
import type { VirusScannerPort } from "@/modules/documents/contracts/file-storage";
import { FILE_STATUSES } from "@/modules/documents/domain/file-policy";
import { MemoryObjectStorage } from "@/modules/documents/infrastructure/memory-object-storage";
import { replayDeadLetterJob } from "@/modules/governance/application/replay-job";
import type { JobExecution } from "@/modules/governance/contracts/jobs";
import { payloadHash } from "@/modules/governance/domain/idempotency";
import { completeClaimedJob, failClaimedJob } from "@/modules/governance/infrastructure/job-store";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const storage = new MemoryObjectStorage();
const ids = {
  admin: `files-admin-${suffix}`,
  engineer: `files-engineer-${suffix}`,
  projectA: `files-project-a-${suffix}`,
  projectB: `files-project-b-${suffix}`
};

function context(actorId: string, operationId: string, projectId = ids.projectA): AuditContext {
  return {
    actorId,
    requestId: `request-${operationId}`,
    traceId: `trace-${operationId}`,
    source: "API",
    sourceIp: "127.0.0.1",
    userAgent: "Vitest",
    reason: null,
    projectId,
    departmentId: "engineering",
    operationId
  };
}

async function upload(bytes: Uint8Array, options?: { mimeType?: string; sensitivity?: string }) {
  const mimeType = options?.mimeType ?? "application/octet-stream";
  const started = await startFileUpload(
    {
      projectId: ids.projectA,
      actorId: ids.engineer,
      originalName: `test-${randomUUID()}.bin`,
      mimeType,
      size: bytes.byteLength,
      sensitivity: options?.sensitivity,
      auditContext: context(ids.engineer, `start-${randomUUID()}`)
    },
    storage
  );
  const part = await createUploadPartUrl({
    sessionId: started.upload.sessionId,
    partNumber: 1,
    storage
  });
  const etag = storage.uploadPart(part.uploadUrl, bytes);
  const completion = {
    sessionId: started.upload.sessionId,
    actorId: ids.engineer,
    idempotencyKey: `complete-${randomUUID()}`,
    mimeType,
    size: bytes.byteLength,
    parts: [{ partNumber: 1, etag, size: bytes.byteLength }],
    auditContext: context(ids.engineer, `complete-audit-${randomUUID()}`)
  };
  const completed = await completeFileUpload(completion, storage);
  return { started, completed, completion };
}

function scanJob(
  fileId: string,
  input: Partial<Pick<JobExecution, "attemptNumber" | "maxAttempts" | "isReplay">> = {}
): JobExecution {
  const attemptNumber = input.attemptNumber ?? 1;
  return {
    id: `scan-job-${fileId}`,
    jobType: "file.scan.requested",
    payload: { fileId, processorVersion: "v1" },
    payloadHash: payloadHash({ fileId, processorVersion: "v1" }).hash,
    idempotencyKey: `${fileId}:scan:v1`,
    attemptId: `scan-attempt-${fileId}-${attemptNumber}`,
    attemptNumber,
    maxAttempts: input.maxAttempts ?? 3,
    isReplay: input.isReplay ?? false,
    workerId: `file-worker-${suffix}`
  };
}

const cleanScanner: VirusScannerPort = {
  async scan() {
    return { result: "CLEAN", engine: "test-scanner", version: "1" };
  }
};

describeDatabase("APM-005 PostgreSQL file pipeline", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `FILES-ADMIN-${suffix}`,
          name: "文件管理员",
          departmentId: "hq"
        },
        {
          id: ids.engineer,
          employeeNo: `FILES-ENG-${suffix}`,
          name: "文件工程师",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `files-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        { id: `files-role-engineer-${suffix}`, userId: ids.engineer, roleId: "role-engineer" }
      ]
    });
    await db.project.createMany({
      data: [
        {
          id: ids.projectA,
          code: `FILES-A-${suffix}`,
          name: "文件测试项目 A",
          departmentId: "engineering",
          createdById: ids.admin
        },
        {
          id: ids.projectB,
          code: `FILES-B-${suffix}`,
          name: "文件测试项目 B",
          departmentId: "other",
          createdById: ids.admin
        }
      ]
    });
    await db.projectMember.create({
      data: {
        id: `files-membership-${suffix}`,
        projectId: ids.projectA,
        userId: ids.engineer,
        projectRole: ProjectRole.ENGINEER,
        departmentId: "engineering",
        assignedById: ids.admin
      }
    });
  });

  it("completes once, persists part facts, and detects idempotency payload conflicts", async () => {
    const bytes = new TextEncoder().encode("idempotent upload");
    const result = await upload(bytes, { mimeType: "text/plain" });
    expect(result.completed).toMatchObject({
      repeated: false,
      file: { status: FILE_STATUSES.PENDING_SCAN }
    });
    const repeated = await completeFileUpload(result.completion, storage);
    expect(repeated).toMatchObject({ repeated: true, file: { id: result.completed.file.id } });
    await expect(
      completeFileUpload(
        {
          ...result.completion,
          parts: [{ partNumber: 1, etag: "different-etag", size: bytes.byteLength }]
        },
        storage
      )
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
    await expect(
      db.fileUploadPart.findUniqueOrThrow({
        where: {
          uploadSessionId_partNumber: {
            uploadSessionId: result.started.upload.sessionId,
            partNumber: 1
          }
        }
      })
    ).resolves.toMatchObject({ completedSize: BigInt(bytes.byteLength) });
    await expect(
      db.outboxEvent.count({
        where: {
          eventType: "file.scan.requested",
          aggregateId: result.completed.file.id
        }
      })
    ).resolves.toBe(1);
  });

  it("rejects missing parts and completion MIME/size mismatches before formalizing an object", async () => {
    const sixMegabytes = 6 * 1024 * 1024;
    const started = await startFileUpload(
      {
        projectId: ids.projectA,
        actorId: ids.engineer,
        originalName: "multipart.bin",
        mimeType: "application/octet-stream",
        size: sixMegabytes,
        auditContext: context(ids.engineer, `multipart-${suffix}`)
      },
      storage
    );
    await expect(
      completeFileUpload(
        {
          sessionId: started.upload.sessionId,
          actorId: ids.engineer,
          idempotencyKey: `missing-${suffix}`,
          mimeType: "application/octet-stream",
          size: sixMegabytes,
          parts: [{ partNumber: 1, etag: "one", size: 5 * 1024 * 1024 }],
          auditContext: context(ids.engineer, `missing-${suffix}`)
        },
        storage
      )
    ).rejects.toMatchObject({ code: "MISSING_UPLOAD_PARTS", status: 409 });
    await expect(
      completeFileUpload(
        {
          sessionId: started.upload.sessionId,
          actorId: ids.engineer,
          idempotencyKey: `mime-${suffix}`,
          mimeType: "text/plain",
          size: sixMegabytes,
          parts: [
            { partNumber: 1, etag: "one", size: 5 * 1024 * 1024 },
            { partNumber: 2, etag: "two", size: 1024 * 1024 }
          ],
          auditContext: context(ids.engineer, `mime-${suffix}`)
        },
        storage
      )
    ).rejects.toMatchObject({ code: "UPLOAD_MIME_MISMATCH", status: 409 });
    await expect(
      db.fileObject.findUniqueOrThrow({ where: { id: started.file.id } })
    ).resolves.toMatchObject({ status: FILE_STATUSES.UPLOADING });
  });

  it("hashes and scans idempotently, quarantining infected files", async () => {
    const cleanBytes = new TextEncoder().encode("clean payload");
    const clean = await upload(cleanBytes);
    const handler = createFileScanHandler({ storage, scanner: cleanScanner });
    const job = scanJob(clean.completed.file.id);
    await handler(job);
    await handler(job);
    await expect(
      db.fileObject.findUniqueOrThrow({ where: { id: clean.completed.file.id } })
    ).resolves.toMatchObject({
      status: FILE_STATUSES.AVAILABLE,
      sha256: createHash("sha256").update(cleanBytes).digest("hex"),
      scanEngine: "test-scanner"
    });
    await expect(
      db.auditLog.count({
        where: { objectId: clean.completed.file.id, action: "FILE_SCAN_COMPLETED" }
      })
    ).resolves.toBe(1);

    const infected = await upload(new TextEncoder().encode("infected payload"));
    const infectedHandler = createFileScanHandler({
      storage,
      scanner: {
        async scan() {
          return {
            result: "INFECTED",
            engine: "test-scanner",
            version: "1",
            signature: "EICAR-Test-Signature"
          };
        }
      }
    });
    await infectedHandler(scanJob(infected.completed.file.id));
    await expect(
      db.fileObject.findUniqueOrThrow({ where: { id: infected.completed.file.id } })
    ).resolves.toMatchObject({
      status: FILE_STATUSES.QUARANTINED,
      scanSignature: "EICAR-Test-Signature"
    });
  });

  it("tracks scan retries, Dead Letter, and an idempotent replay recovery", async () => {
    const uploaded = await upload(new TextEncoder().encode("retry payload"));
    const fileId = uploaded.completed.file.id;
    const persistentJobId = `file-dead-letter-${suffix}`;
    const firstAttemptId = `file-attempt-1-${suffix}`;
    const now = new Date();
    const payload = { fileId, processorVersion: "v1" };
    await db.persistentJob.create({
      data: {
        id: persistentJobId,
        jobType: "file.scan.requested",
        payload,
        payloadHash: payloadHash(payload).hash,
        idempotencyKey: `dead-letter-${fileId}`,
        status: JobStatus.RUNNING,
        maxAttempts: 2,
        attemptCount: 1,
        cycleAttemptCount: 1,
        lockedAt: now,
        lockedBy: `retry-worker-${suffix}`,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        attempts: {
          create: {
            id: firstAttemptId,
            attemptNumber: 1,
            status: JobAttemptStatus.RUNNING,
            startedAt: now,
            workerId: `retry-worker-${suffix}`
          }
        }
      }
    });
    const failingHandler = createFileScanHandler({
      storage,
      scanner: {
        async scan() {
          throw new Error("scanner unavailable");
        }
      }
    });
    const firstJob: JobExecution = {
      ...scanJob(fileId, { attemptNumber: 1, maxAttempts: 2 }),
      id: persistentJobId,
      attemptId: firstAttemptId,
      idempotencyKey: `dead-letter-${fileId}`,
      workerId: `retry-worker-${suffix}`
    };
    await expect(failingHandler(firstJob)).rejects.toThrow("scanner unavailable");
    await failClaimedJob(
      firstJob,
      { code: "SCANNER_UNAVAILABLE", message: "first" },
      {
        retryBaseSeconds: 1,
        retryMaxSeconds: 10
      }
    );
    await expect(db.fileObject.findUniqueOrThrow({ where: { id: fileId } })).resolves.toMatchObject(
      {
        status: FILE_STATUSES.PENDING_SCAN
      }
    );

    const secondAttempt = await db.jobAttempt.findFirstOrThrow({
      where: { jobId: persistentJobId, status: JobAttemptStatus.QUEUED }
    });
    await db.$transaction([
      db.jobAttempt.update({
        where: { id: secondAttempt.id },
        data: {
          status: JobAttemptStatus.RUNNING,
          startedAt: new Date(),
          workerId: firstJob.workerId
        }
      }),
      db.persistentJob.update({
        where: { id: persistentJobId },
        data: {
          status: JobStatus.RUNNING,
          attemptCount: 2,
          cycleAttemptCount: 2,
          lockedAt: new Date(),
          lockedBy: firstJob.workerId,
          leaseExpiresAt: new Date(Date.now() + 60_000)
        }
      })
    ]);
    const secondJob: JobExecution = {
      ...firstJob,
      attemptId: secondAttempt.id,
      attemptNumber: 2
    };
    await expect(failingHandler(secondJob)).rejects.toThrow("scanner unavailable");
    await failClaimedJob(
      secondJob,
      { code: "SCANNER_UNAVAILABLE", message: "second" },
      {
        retryBaseSeconds: 1,
        retryMaxSeconds: 10
      }
    );
    await expect(
      db.persistentJob.findUniqueOrThrow({ where: { id: persistentJobId } })
    ).resolves.toMatchObject({
      status: JobStatus.DEAD_LETTER
    });
    await expect(db.fileObject.findUniqueOrThrow({ where: { id: fileId } })).resolves.toMatchObject(
      {
        status: FILE_STATUSES.FAILED,
        failureCode: "SCAN_PROCESSING_FAILED"
      }
    );

    const admin = await loadAuthorizationActor(ids.admin);
    if (!admin) throw new Error("admin actor missing");
    const replay = await replayDeadLetterJob({
      jobId: persistentJobId,
      actor: admin,
      reason: "扫描服务恢复",
      auditContext: context(ids.admin, `file-replay-${suffix}`)
    });
    const replayAttempt = await db.jobAttempt.findFirstOrThrow({
      where: { jobId: persistentJobId, attemptNumber: replay.attemptNumber }
    });
    await db.$transaction([
      db.jobAttempt.update({
        where: { id: replayAttempt.id },
        data: {
          status: JobAttemptStatus.RUNNING,
          startedAt: new Date(),
          workerId: firstJob.workerId
        }
      }),
      db.persistentJob.update({
        where: { id: persistentJobId },
        data: {
          status: JobStatus.RUNNING,
          attemptCount: replay.attemptNumber,
          cycleAttemptCount: 1,
          lockedAt: new Date(),
          lockedBy: firstJob.workerId,
          leaseExpiresAt: new Date(Date.now() + 60_000)
        }
      })
    ]);
    const replayJob: JobExecution = {
      ...firstJob,
      attemptId: replayAttempt.id,
      attemptNumber: replay.attemptNumber,
      isReplay: true
    };
    await createFileScanHandler({ storage, scanner: cleanScanner })(replayJob);
    await completeClaimedJob(replayJob);
    await expect(db.fileObject.findUniqueOrThrow({ where: { id: fileId } })).resolves.toMatchObject(
      {
        status: FILE_STATUSES.AVAILABLE,
        failureCode: null
      }
    );
  });

  it("enforces download state, project relation, sensitivity, and audit without exposing keys", async () => {
    const uploaded = await upload(new TextEncoder().encode("download payload"));
    await createFileScanHandler({ storage, scanner: cleanScanner })(
      scanJob(uploaded.completed.file.id)
    );
    const handler = createDownloadHandler(() => storage);
    const request = (projectId: string, fileId: string, userId: string, requestId: string) =>
      new Request(`http://localhost/api/projects/${projectId}/files/${fileId}/download`, {
        headers: { "x-apm-user-id": userId, "x-request-id": requestId }
      });

    const allowed = await handler(
      request(ids.projectA, uploaded.completed.file.id, ids.engineer, `download-ok-${suffix}`),
      { params: Promise.resolve({ projectId: ids.projectA, fileId: uploaded.completed.file.id }) }
    );
    expect(allowed.status).toBe(200);
    const allowedBody = (await allowed.json()) as { downloadUrl: string };
    expect(allowedBody.downloadUrl).not.toContain(
      (await db.fileObject.findUniqueOrThrow({ where: { id: uploaded.completed.file.id } }))
        .objectKey
    );

    await db.fileObject.update({
      where: { id: uploaded.completed.file.id },
      data: { sensitivity: "RESTRICTED", version: { increment: 1 } }
    });
    const restricted = await handler(
      request(
        ids.projectA,
        uploaded.completed.file.id,
        ids.engineer,
        `download-restricted-${suffix}`
      ),
      { params: Promise.resolve({ projectId: ids.projectA, fileId: uploaded.completed.file.id }) }
    );
    expect(restricted.status).toBe(403);
    const adminAllowed = await handler(
      request(ids.projectA, uploaded.completed.file.id, ids.admin, `download-admin-${suffix}`),
      { params: Promise.resolve({ projectId: ids.projectA, fileId: uploaded.completed.file.id }) }
    );
    expect(adminAllowed.status).toBe(200);

    const crossProject = await handler(
      request(ids.projectB, uploaded.completed.file.id, ids.admin, `download-idor-${suffix}`),
      { params: Promise.resolve({ projectId: ids.projectB, fileId: uploaded.completed.file.id }) }
    );
    expect(crossProject.status).toBe(404);

    const pending = await db.fileObject.create({
      data: {
        projectId: ids.projectA,
        uploadedById: ids.engineer,
        originalName: "pending.bin",
        declaredMimeType: "application/octet-stream",
        declaredSize: 1n,
        verifiedMimeType: "application/octet-stream",
        verifiedSize: 1n,
        objectKey: randomUUID(),
        status: FILE_STATUSES.PENDING_SCAN
      }
    });
    const wrongState = await handler(
      request(ids.projectA, pending.id, ids.engineer, `download-state-${suffix}`),
      { params: Promise.resolve({ projectId: ids.projectA, fileId: pending.id }) }
    );
    expect(wrongState.status).toBe(409);

    await expect(
      db.auditLog.count({
        where: {
          objectType: "FILE_OBJECT",
          objectId: { in: [uploaded.completed.file.id, pending.id] },
          action: "AUTHORIZATION_DENIED"
        }
      })
    ).resolves.toBeGreaterThanOrEqual(3);
  });
});
