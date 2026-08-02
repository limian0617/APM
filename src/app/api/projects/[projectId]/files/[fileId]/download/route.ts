import { decideAuthorization } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
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
