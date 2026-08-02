import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { startFileUpload } from "@/modules/documents/application/file-upload-service";
import { fileErrorResponse } from "@/modules/documents/contracts/file-http";
import { createS3ObjectStorageFromEnvironment } from "@/modules/documents/infrastructure/s3-object-storage";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  projectPathSchema,
  startFileUploadBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };

async function startUpload(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.FILE_UPLOAD);
  if (!guard.authorized) return guard.response;

  try {
    const path = parsePath(projectPathSchema, { projectId });
    const input = await parseJsonBody(request, startFileUploadBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "files.upload.start",
      idempotencyKey,
      request: { path, body: input },
      execute: async (transaction) => ({
        status: 201,
        body: await startFileUpload(
          {
            projectId: path.projectId,
            actorId: guard.actor.id,
            originalName: input.originalName,
            mimeType: input.mimeType,
            size: input.size,
            sensitivity: input.sensitivity,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId
            })
          },
          createS3ObjectStorageFromEnvironment(),
          transaction
        )
      })
    });
  } catch (error) {
    const contractResponse = apiContractErrorResponse(error);
    if (contractResponse) return contractResponse;
    const response = fileErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const POST = withRequestObservability(
  { module: "files", operation: "start-upload" },
  startUpload
);
