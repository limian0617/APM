import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import {
  createUploadPartUrl,
  findUploadAuthorizationTarget
} from "@/modules/documents/application/file-upload-service";
import { fileErrorResponse } from "@/modules/documents/contracts/file-http";
import { FileValidationError } from "@/modules/documents/domain/file-policy";
import { createS3ObjectStorageFromEnvironment } from "@/modules/documents/infrastructure/s3-object-storage";

type RouteContext = {
  params: Promise<{ projectId: string; sessionId: string; partNumber: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { projectId, sessionId, partNumber } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.FILE_UPLOAD);
  if (!guard.authorized) return guard.response;

  try {
    const target = await findUploadAuthorizationTarget(sessionId);
    if (!target || target.fileObject.projectId !== projectId) {
      throw new FileValidationError("UPLOAD_SESSION_NOT_FOUND", "上传会话不存在。", 404);
    }
    return Response.json(
      await createUploadPartUrl({
        sessionId,
        partNumber: Number(partNumber),
        storage: createS3ObjectStorageFromEnvironment()
      })
    );
  } catch (error) {
    const response = fileErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
