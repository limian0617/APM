import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  completeFileUpload,
  findUploadAuthorizationTarget
} from "@/modules/documents/application/file-upload-service";
import { fileErrorResponse } from "@/modules/documents/contracts/file-http";
import { FileValidationError } from "@/modules/documents/domain/file-policy";
import { createS3ObjectStorageFromEnvironment } from "@/modules/documents/infrastructure/s3-object-storage";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  completeFileUploadBodySchema,
  uploadSessionPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string; sessionId: string }> };

async function completeUpload(request: Request, context: RouteContext) {
  const { projectId, sessionId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.FILE_UPLOAD);
  if (!guard.authorized) return guard.response;

  try {
    const path = parsePath(uploadSessionPathSchema, { projectId, sessionId });
    const input = await parseJsonBody(request, completeFileUploadBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const target = await findUploadAuthorizationTarget(path.sessionId);
    if (!target || target.fileObject.projectId !== path.projectId) {
      throw new FileValidationError("UPLOAD_SESSION_NOT_FOUND", "上传会话不存在。", 404);
    }
    return Response.json(
      await completeFileUpload(
        {
          sessionId: path.sessionId,
          actorId: guard.actor.id,
          idempotencyKey,
          mimeType: input.mimeType,
          size: input.size,
          parts: input.parts,
          auditContext: auditContextFromRequest(request, {
            actorId: guard.actor.id,
            projectId: path.projectId,
            departmentId: guard.project.departmentId
          })
        },
        createS3ObjectStorageFromEnvironment()
      )
    );
  } catch (error) {
    const contractResponse = apiContractErrorResponse(error);
    if (contractResponse) return contractResponse;
    const response = fileErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const POST = withRequestObservability(
  { module: "files", operation: "complete-upload" },
  completeUpload
);
