import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { startFileUpload } from "@/modules/documents/application/file-upload-service";
import { fileErrorResponse } from "@/modules/documents/contracts/file-http";
import { createS3ObjectStorageFromEnvironment } from "@/modules/documents/infrastructure/s3-object-storage";

type RouteContext = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.FILE_UPLOAD);
  if (!guard.authorized) return guard.response;

  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(
        { error: { code: "INVALID_BODY", message: "请求体必须是 JSON 对象。" } },
        { status: 422 }
      );
    }
    const input = body as Record<string, unknown>;
    const result = await startFileUpload(
      {
        projectId,
        actorId: guard.actor.id,
        originalName: input.originalName,
        mimeType: input.mimeType,
        size: input.size,
        sensitivity: input.sensitivity,
        auditContext: auditContextFromRequest(request, {
          actorId: guard.actor.id,
          projectId,
          departmentId: guard.project.departmentId
        })
      },
      createS3ObjectStorageFromEnvironment()
    );
    return Response.json(result, { status: 201 });
  } catch (error) {
    const response = fileErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
