import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_RESULTS,
  FILE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";

import { STORAGE_AREAS, type ObjectStoragePort } from "../contracts/file-storage";
import { assertFileUsable, FILE_USE_ACTIONS, FileValidationError } from "../domain/file-policy";

const DOWNLOAD_URL_SECONDS = 5 * 60;

export async function findFileAuthorizationTarget(projectId: string, fileId: string) {
  return db.fileObject.findFirst({
    where: { id: fileId, projectId },
    select: {
      id: true,
      projectId: true,
      uploadedById: true,
      originalName: true,
      declaredMimeType: true,
      verifiedMimeType: true,
      objectKey: true,
      storageArea: true,
      status: true,
      sensitivity: true
    }
  });
}

export async function recordFileAccessDenied(input: {
  fileId: string;
  context: AuditContext;
  permission: string;
  method: string;
  path: string;
  reason: string;
}) {
  return writeAudit(db, {
    action: AUDIT_ACTIONS.AUTHORIZATION_DENIED,
    objectType: AUDIT_OBJECT_TYPES.FILE_OBJECT,
    objectId: input.fileId,
    result: AUDIT_RESULTS.DENIED,
    context: { ...input.context, reason: input.reason },
    metadata: {
      value: {
        fileId: input.fileId,
        permission: input.permission,
        method: input.method,
        path: input.path
      },
      allowedFields: FILE_AUDIT_FIELDS
    }
  });
}

export async function issueFileDownloadUrl(input: {
  file: NonNullable<Awaited<ReturnType<typeof findFileAuthorizationTarget>>>;
  actorId: string;
  auditContext: AuditContext;
  storage: ObjectStoragePort;
}) {
  try {
    assertFileUsable(input.file.status, FILE_USE_ACTIONS.DOWNLOAD);
  } catch (error) {
    await recordFileAccessDenied({
      fileId: input.file.id,
      context: input.auditContext,
      permission: "FILE_DOWNLOAD",
      method: "GET",
      path: `/api/projects/${input.file.projectId}/files/${input.file.id}/download`,
      reason: "FILE_NOT_AVAILABLE"
    });
    throw error;
  }
  if (input.file.storageArea !== STORAGE_AREAS.CONTROLLED) {
    throw new FileValidationError("FILE_STORAGE_INVALID", "文件尚未进入受控存储。", 409);
  }
  const mimeType = input.file.verifiedMimeType || input.file.declaredMimeType;
  const url = await input.storage.createDownloadUrl({
    area: STORAGE_AREAS.CONTROLLED,
    objectKey: input.file.objectKey,
    downloadName: input.file.originalName,
    mimeType,
    expiresInSeconds: DOWNLOAD_URL_SECONDS
  });
  const audit = await writeAudit(db, {
    action: AUDIT_ACTIONS.FILE_DOWNLOAD_URL_ISSUED,
    objectType: AUDIT_OBJECT_TYPES.FILE_OBJECT,
    objectId: input.file.id,
    context: { ...input.auditContext, actorId: input.actorId, projectId: input.file.projectId },
    metadata: {
      value: {
        fileId: input.file.id,
        projectId: input.file.projectId,
        status: input.file.status,
        sensitivity: input.file.sensitivity,
        expiresInSeconds: DOWNLOAD_URL_SECONDS
      },
      allowedFields: FILE_AUDIT_FIELDS
    }
  });
  return { downloadUrl: url, expiresInSeconds: DOWNLOAD_URL_SECONDS, auditId: audit.id };
}
