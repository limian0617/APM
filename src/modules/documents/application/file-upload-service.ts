import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_RESULTS,
  FILE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { payloadHash } from "@/modules/governance/domain/idempotency";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import { STORAGE_AREAS, type ObjectStoragePort } from "../contracts/file-storage";
import {
  assertCompleteParts,
  FILE_STATUSES,
  multipartLayout,
  normalizeMimeType,
  parseCompletionParts,
  validateFileSize,
  validateIdempotencyKey,
  validateOriginalName,
  validateSensitivity,
  type CompletionPart,
  FileValidationError
} from "../domain/file-policy";

const UPLOAD_SESSION_SECONDS = 24 * 60 * 60;
const PART_URL_SECONDS = 15 * 60;

type StartUploadCommand = {
  projectId: string;
  actorId: string;
  originalName: unknown;
  mimeType: unknown;
  size: unknown;
  sensitivity?: unknown;
  auditContext: AuditContext;
};

type CompleteUploadCommand = {
  sessionId: string;
  actorId: string;
  idempotencyKey: string | null;
  mimeType: unknown;
  size: unknown;
  parts: unknown;
  auditContext: AuditContext;
};

function responseFile(file: {
  id: string;
  projectId: string;
  originalName: string;
  declaredMimeType: string;
  declaredSize: bigint;
  status: string;
  sensitivity: string;
  version: number;
}) {
  return {
    id: file.id,
    projectId: file.projectId,
    originalName: file.originalName,
    mimeType: file.declaredMimeType,
    size: Number(file.declaredSize),
    status: file.status,
    sensitivity: file.sensitivity,
    version: file.version
  };
}

async function databaseNow(transaction: Prisma.TransactionClient): Promise<Date> {
  const [row] = await transaction.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
  if (!row) throw new Error("无法读取数据库时间。");
  return row.now;
}

export async function findUploadAuthorizationTarget(sessionId: string) {
  return db.fileUploadSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      fileObject: {
        select: { id: true, projectId: true, uploadedById: true, sensitivity: true }
      }
    }
  });
}

export async function startFileUpload(command: StartUploadCommand, storage: ObjectStoragePort) {
  const originalName = validateOriginalName(command.originalName);
  const mimeType = normalizeMimeType(command.mimeType);
  const size = validateFileSize(command.size);
  const sensitivity = validateSensitivity(command.sensitivity);
  const { partSize, partSizes } = multipartLayout(size);
  const objectKey = randomUUID();
  const initiated = await storage.beginMultipartUpload({
    area: STORAGE_AREAS.QUARANTINE,
    objectKey,
    mimeType
  });

  try {
    return await db.$transaction(async (transaction) => {
      const now = await databaseNow(transaction);
      const file = await transaction.fileObject.create({
        data: {
          projectId: command.projectId,
          uploadedById: command.actorId,
          originalName,
          declaredMimeType: mimeType,
          declaredSize: BigInt(size),
          objectKey,
          sensitivity,
          uploadSession: {
            create: {
              storageUploadId: initiated.uploadId,
              expectedParts: partSizes.length,
              partSize: BigInt(partSize),
              expiresAt: new Date(now.getTime() + UPLOAD_SESSION_SECONDS * 1000),
              parts: {
                create: partSizes.map((expectedSize, index) => ({
                  partNumber: index + 1,
                  expectedSize: BigInt(expectedSize)
                }))
              }
            }
          }
        },
        include: { uploadSession: true }
      });
      if (!file.uploadSession) throw new Error("上传会话创建失败。");
      const audit = await writeAudit(transaction, {
        action: AUDIT_ACTIONS.FILE_UPLOAD_STARTED,
        objectType: AUDIT_OBJECT_TYPES.FILE_UPLOAD_SESSION,
        objectId: file.uploadSession.id,
        context: {
          ...command.auditContext,
          actorId: command.actorId,
          projectId: command.projectId
        },
        after: {
          value: {
            fileId: file.id,
            sessionId: file.uploadSession.id,
            projectId: file.projectId,
            status: file.status,
            sensitivity: file.sensitivity,
            mimeType,
            size
          },
          allowedFields: FILE_AUDIT_FIELDS
        }
      });
      return {
        file: responseFile(file),
        upload: {
          sessionId: file.uploadSession.id,
          expectedParts: file.uploadSession.expectedParts,
          partSize,
          expiresAt: file.uploadSession.expiresAt
        },
        auditId: audit.id
      };
    });
  } catch (error) {
    await storage
      .abortMultipartUpload({
        area: STORAGE_AREAS.QUARANTINE,
        objectKey,
        uploadId: initiated.uploadId
      })
      .catch(() => undefined);
    throw error;
  }
}

export async function createUploadPartUrl(input: {
  sessionId: string;
  partNumber: number;
  storage: ObjectStoragePort;
}) {
  if (!Number.isInteger(input.partNumber) || input.partNumber < 1) {
    throw new FileValidationError("INVALID_PART_NUMBER", "分片编号无效。");
  }
  const session = await db.fileUploadSession.findUnique({
    where: { id: input.sessionId },
    include: { fileObject: true, parts: { where: { partNumber: input.partNumber } } }
  });
  if (!session) throw new FileValidationError("UPLOAD_SESSION_NOT_FOUND", "上传会话不存在。", 404);
  if (session.status !== "INITIATED" || session.expiresAt <= new Date()) {
    throw new FileValidationError("UPLOAD_SESSION_NOT_ACTIVE", "上传会话已不可继续上传。", 409);
  }
  const part = session.parts[0];
  if (!part) throw new FileValidationError("UPLOAD_PART_NOT_FOUND", "上传分片不存在。", 404);
  const url = await input.storage.createPartUploadUrl({
    area: STORAGE_AREAS.QUARANTINE,
    objectKey: session.fileObject.objectKey,
    uploadId: session.storageUploadId,
    partNumber: part.partNumber,
    expiresInSeconds: PART_URL_SECONDS
  });
  return {
    partNumber: part.partNumber,
    expectedSize: Number(part.expectedSize),
    uploadUrl: url,
    expiresInSeconds: PART_URL_SECONDS
  };
}

type CompletionReservation = {
  session: NonNullable<Awaited<ReturnType<typeof loadCompletionSession>>>;
  parts: CompletionPart[];
  payloadHash: string;
  commandId: string;
  repeated: boolean;
};

async function loadCompletionSession(sessionId: string) {
  return db.fileUploadSession.findUnique({
    where: { id: sessionId },
    include: { fileObject: true, parts: { orderBy: { partNumber: "asc" } } }
  });
}

async function reserveCompletion(
  command: CompleteUploadCommand,
  retryUniqueConflict = true
): Promise<CompletionReservation> {
  const idempotencyKey = validateIdempotencyKey(command.idempotencyKey);
  const parts = parseCompletionParts(command.parts);
  const session = await loadCompletionSession(command.sessionId);
  if (!session) throw new FileValidationError("UPLOAD_SESSION_NOT_FOUND", "上传会话不存在。", 404);
  const mimeType = normalizeMimeType(command.mimeType);
  const size = validateFileSize(command.size);
  if (mimeType !== session.fileObject.declaredMimeType) {
    throw new FileValidationError("UPLOAD_MIME_MISMATCH", "完成上传的 MIME 与声明值不一致。", 409);
  }
  if (BigInt(size) !== session.fileObject.declaredSize) {
    throw new FileValidationError("UPLOAD_SIZE_MISMATCH", "完成上传的大小与声明值不一致。", 409);
  }
  assertCompleteParts(session.parts, parts);
  const canonical = payloadHash({ sessionId: session.id, mimeType, size, parts });

  try {
    return await db.$transaction(async (transaction) => {
      const existing = await transaction.fileCommand.findUnique({
        where: {
          actorId_operation_idempotencyKey: {
            actorId: command.actorId,
            operation: "UPLOAD_COMPLETE",
            idempotencyKey
          }
        }
      });
      if (existing) {
        if (
          existing.fileObjectId !== session.fileObjectId ||
          existing.uploadSessionId !== session.id ||
          existing.payloadHash !== canonical.hash
        ) {
          throw new FileValidationError(
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency-Key 已绑定到不同的上传完成负载。",
            409
          );
        }
        if (existing.status === "FAILED") {
          throw new FileValidationError(
            existing.errorCode || "UPLOAD_COMPLETION_FAILED",
            existing.errorMessage || "上传完成已失败。",
            409
          );
        }
        if (existing.status === "STARTED") {
          const now = await databaseNow(transaction);
          if (now.getTime() - existing.updatedAt.getTime() < 60_000) {
            throw new FileValidationError(
              "UPLOAD_COMPLETION_IN_PROGRESS",
              "相同上传完成命令正在处理中。",
              409
            );
          }
        }
        return {
          session,
          parts,
          payloadHash: canonical.hash,
          commandId: existing.id,
          repeated: existing.status === "SUCCEEDED"
        };
      }

      const sessionCommand = await transaction.fileCommand.findFirst({
        where: { uploadSessionId: session.id, operation: "UPLOAD_COMPLETE" }
      });
      if (sessionCommand || session.status === "COMPLETED" || session.status === "FAILED") {
        throw new FileValidationError(
          "UPLOAD_ALREADY_COMPLETED",
          "上传会话已使用其他幂等命令完成或失败。",
          409
        );
      }
      const now = await databaseNow(transaction);
      if (session.status !== "INITIATED" || session.expiresAt <= now) {
        throw new FileValidationError("UPLOAD_SESSION_NOT_ACTIVE", "上传会话已不可完成。", 409);
      }
      const fileCommand = await transaction.fileCommand.create({
        data: {
          actorId: command.actorId,
          fileObjectId: session.fileObjectId,
          uploadSessionId: session.id,
          operation: "UPLOAD_COMPLETE",
          idempotencyKey,
          payloadHash: canonical.hash
        }
      });
      await transaction.fileUploadSession.update({
        where: { id: session.id },
        data: { status: "COMPLETING" }
      });
      return {
        session,
        parts,
        payloadHash: canonical.hash,
        commandId: fileCommand.id,
        repeated: false
      };
    });
  } catch (error) {
    if (
      retryUniqueConflict &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return reserveCompletion(command, false);
    }
    throw error;
  }
}

async function failCompletion(input: {
  reservation: CompletionReservation;
  command: CompleteUploadCommand;
  code: string;
  message: string;
}) {
  await db.$transaction(async (transaction) => {
    await transaction.fileObject.updateMany({
      where: { id: input.reservation.session.fileObjectId, status: "UPLOADING" },
      data: {
        status: "FAILED",
        failureCode: input.code,
        failureMessage: input.message,
        version: { increment: 1 }
      }
    });
    await transaction.fileUploadSession.update({
      where: { id: input.reservation.session.id },
      data: { status: "FAILED", failureCode: input.code }
    });
    await transaction.fileCommand.update({
      where: { id: input.reservation.commandId },
      data: { status: "FAILED", errorCode: input.code, errorMessage: input.message }
    });
    await writeAudit(transaction, {
      action: AUDIT_ACTIONS.FILE_PROCESSING_FAILED,
      objectType: AUDIT_OBJECT_TYPES.FILE_OBJECT,
      objectId: input.reservation.session.fileObjectId,
      result: AUDIT_RESULTS.FAILURE,
      context: {
        ...input.command.auditContext,
        actorId: input.command.actorId,
        projectId: input.reservation.session.fileObject.projectId
      },
      metadata: {
        value: {
          fileId: input.reservation.session.fileObjectId,
          sessionId: input.reservation.session.id,
          status: FILE_STATUSES.FAILED,
          failureCode: input.code
        },
        allowedFields: FILE_AUDIT_FIELDS
      }
    });
  });
}

export async function completeFileUpload(
  command: CompleteUploadCommand,
  storage: ObjectStoragePort
) {
  const reservation = await reserveCompletion(command);
  if (!reservation.repeated) {
    let facts = await storage.headObject({
      area: STORAGE_AREAS.QUARANTINE,
      objectKey: reservation.session.fileObject.objectKey
    });
    if (!facts) {
      await storage.completeMultipartUpload({
        area: STORAGE_AREAS.QUARANTINE,
        objectKey: reservation.session.fileObject.objectKey,
        uploadId: reservation.session.storageUploadId,
        parts: reservation.parts.map(({ partNumber, etag }) => ({ partNumber, etag }))
      });
      facts = await storage.headObject({
        area: STORAGE_AREAS.QUARANTINE,
        objectKey: reservation.session.fileObject.objectKey
      });
    }
    const verifiedMimeType = facts?.mimeType
      ? normalizeMimeType(facts.mimeType.split(";", 1)[0])
      : null;
    const expectedSize = Number(reservation.session.fileObject.declaredSize);
    if (
      !facts ||
      facts.size !== expectedSize ||
      verifiedMimeType !== reservation.session.fileObject.declaredMimeType
    ) {
      const code = facts?.size !== expectedSize ? "STORED_SIZE_MISMATCH" : "STORED_MIME_MISMATCH";
      const message = "对象存储中的大小或 MIME 与上传声明不一致。";
      await failCompletion({ reservation, command, code, message });
      await storage
        .deleteObject({
          area: STORAGE_AREAS.QUARANTINE,
          objectKey: reservation.session.fileObject.objectKey
        })
        .catch(() => undefined);
      throw new FileValidationError(code, message, 409);
    }

    await db.$transaction(async (transaction) => {
      const updated = await transaction.fileObject.updateMany({
        where: { id: reservation.session.fileObjectId, status: "UPLOADING" },
        data: {
          status: "PENDING_SCAN",
          verifiedMimeType,
          verifiedSize: BigInt(facts.size),
          failureCode: null,
          failureMessage: null,
          version: { increment: 1 }
        }
      });
      if (updated.count === 0) return;
      const now = await databaseNow(transaction);
      await transaction.fileUploadSession.update({
        where: { id: reservation.session.id },
        data: { status: "COMPLETED", completedAt: now, failureCode: null }
      });
      for (const part of reservation.parts) {
        await transaction.fileUploadPart.update({
          where: {
            uploadSessionId_partNumber: {
              uploadSessionId: reservation.session.id,
              partNumber: part.partNumber
            }
          },
          data: { completedSize: BigInt(part.size), etag: part.etag }
        });
      }
      await transaction.fileCommand.update({
        where: { id: reservation.commandId },
        data: {
          status: "SUCCEEDED",
          responseJson: {
            fileId: reservation.session.fileObjectId,
            status: FILE_STATUSES.PENDING_SCAN
          }
        }
      });
      await writeAudit(transaction, {
        action: AUDIT_ACTIONS.FILE_UPLOAD_COMPLETED,
        objectType: AUDIT_OBJECT_TYPES.FILE_OBJECT,
        objectId: reservation.session.fileObjectId,
        context: {
          ...command.auditContext,
          actorId: command.actorId,
          projectId: reservation.session.fileObject.projectId
        },
        after: {
          value: {
            fileId: reservation.session.fileObjectId,
            sessionId: reservation.session.id,
            projectId: reservation.session.fileObject.projectId,
            status: FILE_STATUSES.PENDING_SCAN,
            sensitivity: reservation.session.fileObject.sensitivity,
            mimeType: verifiedMimeType,
            size: facts.size
          },
          allowedFields: FILE_AUDIT_FIELDS
        }
      });
      await appendOutboxEvent(transaction, {
        eventType: "file.scan.requested",
        aggregateType: "FILE_OBJECT",
        aggregateId: reservation.session.fileObjectId,
        idempotencyKey: `${reservation.session.fileObjectId}:scan:v1`,
        payload: { fileId: reservation.session.fileObjectId, processorVersion: "v1" }
      });
    });
  }

  const file = await db.fileObject.findUniqueOrThrow({
    where: { id: reservation.session.fileObjectId }
  });
  return { file: responseFile(file), repeated: reservation.repeated };
}
