import { decideAuthorization } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { isConfirmationEvidenceFile } from "@/modules/acceptance/application/acceptance-report-service";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  ACCEPTANCE_CONFIRMATION_AUDIT_FIELDS,
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { db } from "@/lib/db";
import {
  findFileAuthorizationTarget,
  issueFileDownloadUrl,
  recordFileAccessDenied
} from "@/modules/documents/application/file-download-service";
import { fileErrorResponse } from "@/modules/documents/contracts/file-http";
import { FILE_SENSITIVITIES } from "@/modules/documents/domain/file-policy";
import { createS3ObjectStorageFromEnvironment } from "@/modules/documents/infrastructure/s3-object-storage";
import type { ObjectStoragePort } from "@/modules/documents/contracts/file-storage";
import { withRequestObservability } from "@/modules/observability/application/request-observer";

type RouteContext = { params: Promise<{ projectId: string; fileId: string }> };

function forbidden(): Response {
  return Response.json(
    { error: { code: "FORBIDDEN", message: "当前角色无权下载此文件。" } },
    { status: 403 }
  );
}

export function createDownloadHandler(storageFactory: () => ObjectStoragePort) {
  return async function download(request: Request, context: RouteContext) {
    const { projectId, fileId } = await context.params;
    const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.FILE_DOWNLOAD);
    if (!guard.authorized) return guard.response;
    const url = new URL(request.url);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId,
      departmentId: guard.project.departmentId
    });
    const file = await findFileAuthorizationTarget(projectId, fileId);
    if (!file) {
      await recordFileAccessDenied({
        fileId,
        context: auditContext,
        permission: PERMISSIONS.FILE_DOWNLOAD,
        method: request.method,
        path: url.pathname,
        reason: "FILE_NOT_FOUND_OR_UNRELATED"
      });
      return Response.json(
        { error: { code: "FILE_NOT_FOUND", message: "文件不存在。" } },
        { status: 404 }
      );
    }

    if (file.sensitivity === FILE_SENSITIVITIES.RESTRICTED) {
      const sensitiveDecision = decideAuthorization(guard.actor, PERMISSIONS.SENSITIVE_FILE_READ, {
        projectId,
        resourceDepartmentId: guard.project.departmentId,
        resourceOwnerId: file.uploadedById,
        memberRoles: guard.project.memberRoles
      });
      if (!sensitiveDecision.allowed) {
        await recordFileAccessDenied({
          fileId,
          context: auditContext,
          permission: PERMISSIONS.SENSITIVE_FILE_READ,
          method: request.method,
          path: url.pathname,
          reason: sensitiveDecision.reason
        });
        return forbidden();
      }
    }

    const confirmationEvidence = await isConfirmationEvidenceFile({ projectId, fileId });
    if (confirmationEvidence) {
      const confirmationContext = {
        projectId,
        resourceDepartmentId: guard.project.departmentId,
        resourceOwnerId: file.uploadedById,
        memberRoles: guard.project.memberRoles
      };
      const acceptanceDecision = decideAuthorization(
        guard.actor,
        PERMISSIONS.ACCEPTANCE_READ,
        confirmationContext
      );
      const confirmationDecision = decideAuthorization(
        guard.actor,
        PERMISSIONS.SENSITIVE_CONFIRMATION_READ,
        confirmationContext
      );
      if (!acceptanceDecision.allowed || !confirmationDecision.allowed) {
        const missingAcceptanceRead = !acceptanceDecision.allowed;
        const permission = missingAcceptanceRead
          ? PERMISSIONS.ACCEPTANCE_READ
          : PERMISSIONS.SENSITIVE_CONFIRMATION_READ;
        const reason = missingAcceptanceRead
          ? acceptanceDecision.reason
          : confirmationDecision.allowed
            ? "PERMISSION_NOT_GRANTED"
            : confirmationDecision.reason;
        await recordFileAccessDenied({
          fileId,
          context: auditContext,
          permission,
          method: request.method,
          path: url.pathname,
          reason
        });
        return forbidden();
      }
      await writeAudit(db, {
        action: AUDIT_ACTIONS.ACCEPTANCE_CONFIRMATION_READ,
        objectType: AUDIT_OBJECT_TYPES.ACCEPTANCE_CONFIRMATION_EVIDENCE,
        objectId: confirmationEvidence.id,
        context: { ...auditContext, projectId },
        metadata: {
          value: {
            projectId,
            confirmationId: confirmationEvidence.confirmationId,
            evidenceFileId: fileId,
            reason: "下载敏感客户确认凭证"
          },
          allowedFields: ACCEPTANCE_CONFIRMATION_AUDIT_FIELDS
        }
      });
    }

    try {
      return Response.json(
        await issueFileDownloadUrl({
          file,
          actorId: guard.actor.id,
          auditContext,
          storage: storageFactory()
        })
      );
    } catch (error) {
      const response = fileErrorResponse(error);
      if (response) return response;
      throw error;
    }
  };
}

export const GET = withRequestObservability(
  { module: "files", operation: "download" },
  createDownloadHandler(createS3ObjectStorageFromEnvironment)
);
