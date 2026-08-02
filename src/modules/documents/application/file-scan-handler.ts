import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_RESULTS,
  AUDIT_SOURCES,
  FILE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import type { JobExecution, JobHandler } from "@/modules/governance/contracts/jobs";

import {
  STORAGE_AREAS,
  type ObjectStoragePort,
  type VirusScannerPort
} from "../contracts/file-storage";
import { FILE_STATUSES } from "../domain/file-policy";

function jobPayload(job: JobExecution): { fileId: string; processorVersion: string } {
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
    throw new TypeError("文件扫描作业负载必须是对象。");
  }
  const payload = job.payload as Record<string, unknown>;
  if (typeof payload.fileId !== "string" || typeof payload.processorVersion !== "string") {
    throw new TypeError("文件扫描作业缺少 fileId 或 processorVersion。");
  }
  return { fileId: payload.fileId, processorVersion: payload.processorVersion };
}

function auditContext(job: JobExecution, projectId: string): AuditContext {
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

async function sha256(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function databaseNow(transaction: Prisma.TransactionClient): Promise<Date> {
  const [row] = await transaction.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
  if (!row) throw new Error("无法读取数据库时间。");
  return row.now;
}

function failureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "文件扫描处理失败。").slice(0, 2048);
}

export function createFileScanHandler(input: {
  storage: ObjectStoragePort;
  scanner: VirusScannerPort;
}): JobHandler {
  return async (job) => {
    const payload = jobPayload(job);
    let file = await db.fileObject.findUnique({ where: { id: payload.fileId } });
    if (!file) throw new Error("文件扫描作业引用的 FileObject 不存在。");

    if (file.status === FILE_STATUSES.AVAILABLE || file.status === FILE_STATUSES.QUARANTINED) {
      return;
    }
    if (
      file.status === FILE_STATUSES.FAILED &&
      job.isReplay &&
      file.failureCode === "SCAN_PROCESSING_FAILED"
    ) {
      await db.fileObject.update({
        where: { id: file.id },
        data: {
          status: FILE_STATUSES.PENDING_SCAN,
          failureCode: null,
          failureMessage: null,
          version: { increment: 1 }
        }
      });
      file = await db.fileObject.findUniqueOrThrow({ where: { id: file.id } });
    }
    if (file.status !== FILE_STATUSES.PENDING_SCAN) {
      throw new Error(`文件处于 ${file.status} 状态，不能执行扫描。`);
    }

    try {
      const digest = await sha256(
        await input.storage.readObject({
          area: STORAGE_AREAS.QUARANTINE,
          objectKey: file.objectKey
        })
      );
      const scan = await input.scanner.scan(
        await input.storage.readObject({
          area: STORAGE_AREAS.QUARANTINE,
          objectKey: file.objectKey
        })
      );

      if (scan.result === "INFECTED") {
        await db.$transaction(async (transaction) => {
          const scannedAt = await databaseNow(transaction);
          const changed = await transaction.fileObject.updateMany({
            where: { id: file.id, status: FILE_STATUSES.PENDING_SCAN },
            data: {
              status: FILE_STATUSES.QUARANTINED,
              sha256: digest,
              scanEngine: scan.engine.slice(0, 191),
              scannerVersion: scan.version.slice(0, 191),
              scanSignature: scan.signature.slice(0, 512),
              scannedAt,
              version: { increment: 1 }
            }
          });
          if (changed.count === 0) return;
          await writeAudit(transaction, {
            action: AUDIT_ACTIONS.FILE_QUARANTINED,
            objectType: AUDIT_OBJECT_TYPES.FILE_OBJECT,
            objectId: file.id,
            context: auditContext(job, file.projectId),
            after: {
              value: {
                fileId: file.id,
                status: FILE_STATUSES.QUARANTINED,
                sha256: digest,
                scanEngine: scan.engine,
                scannerVersion: scan.version,
                scanSignature: scan.signature
              },
              allowedFields: FILE_AUDIT_FIELDS
            }
          });
        });
        return;
      }

      await input.storage.copyObject({
        sourceArea: STORAGE_AREAS.QUARANTINE,
        destinationArea: STORAGE_AREAS.CONTROLLED,
        objectKey: file.objectKey,
        mimeType: file.verifiedMimeType || file.declaredMimeType
      });
      await db.$transaction(async (transaction) => {
        const scannedAt = await databaseNow(transaction);
        const changed = await transaction.fileObject.updateMany({
          where: { id: file.id, status: FILE_STATUSES.PENDING_SCAN },
          data: {
            status: FILE_STATUSES.AVAILABLE,
            storageArea: STORAGE_AREAS.CONTROLLED,
            sha256: digest,
            scanEngine: scan.engine.slice(0, 191),
            scannerVersion: scan.version.slice(0, 191),
            scanSignature: null,
            scannedAt,
            failureCode: null,
            failureMessage: null,
            version: { increment: 1 }
          }
        });
        if (changed.count === 0) return;
        await writeAudit(transaction, {
          action: AUDIT_ACTIONS.FILE_SCAN_COMPLETED,
          objectType: AUDIT_OBJECT_TYPES.FILE_OBJECT,
          objectId: file.id,
          context: auditContext(job, file.projectId),
          after: {
            value: {
              fileId: file.id,
              status: FILE_STATUSES.AVAILABLE,
              sha256: digest,
              scanEngine: scan.engine,
              scannerVersion: scan.version
            },
            allowedFields: FILE_AUDIT_FIELDS
          }
        });
      });
      await input.storage
        .deleteObject({ area: STORAGE_AREAS.QUARANTINE, objectKey: file.objectKey })
        .catch(() => undefined);
    } catch (error) {
      if (job.attemptNumber >= job.maxAttempts) {
        const message = failureMessage(error);
        await db.$transaction(async (transaction) => {
          const changed = await transaction.fileObject.updateMany({
            where: { id: file.id, status: FILE_STATUSES.PENDING_SCAN },
            data: {
              status: FILE_STATUSES.FAILED,
              failureCode: "SCAN_PROCESSING_FAILED",
              failureMessage: message,
              version: { increment: 1 }
            }
          });
          if (changed.count === 0) return;
          await writeAudit(transaction, {
            action: AUDIT_ACTIONS.FILE_PROCESSING_FAILED,
            objectType: AUDIT_OBJECT_TYPES.FILE_OBJECT,
            objectId: file.id,
            result: AUDIT_RESULTS.FAILURE,
            context: auditContext(job, file.projectId),
            metadata: {
              value: {
                fileId: file.id,
                status: FILE_STATUSES.FAILED,
                failureCode: "SCAN_PROCESSING_FAILED"
              },
              allowedFields: FILE_AUDIT_FIELDS
            }
          });
        });
      }
      throw error;
    }
  };
}
