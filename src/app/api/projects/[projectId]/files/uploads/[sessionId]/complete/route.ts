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

type RouteContext = { params: Promise<{ projectId: string; sessionId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { projectId, sessionId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.FILE_UPLOAD);
  if (!guard.authorized) return guard.response;

  try {
    const target = await findUploadAuthorizationTarget(sessionId);
    if (!target || target.fileObject.projectId !== projectId) {
      throw new FileValidationError("UPLOAD_SESSION_NOT_FOUND", "上传会话不存在。", 404);
    }
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(
        { error: { code: "INVALID_BODY", message: "请求体必须是 JSON 对象。" } },
        { status: 422 }
      );
    }
    const input = body as Record<string, unknown>;
    return Response.json(
      await completeFileUpload(
        {
          sessionId,
          actorId: guard.actor.id,
          idempotencyKey: request.headers.get("idempotency-key"),
          mimeType: input.mimeType,
          size: input.size,
          parts: input.parts,
          auditContext: auditContextFromRequest(request, {
            actorId: guard.actor.id,
            projectId,
            departmentId: guard.project.departmentId
          })
        },
        createS3ObjectStorageFromEnvironment()
      )
    );
  } catch (error) {
    const response = fileErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
