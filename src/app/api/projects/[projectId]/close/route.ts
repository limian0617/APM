import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import {
  closeProject,
  ProjectCloseError
} from "@/modules/projects/application/project-close-service";
import { archiveCloseBodySchema } from "@/modules/archives/contracts/archive-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import {
  apiContractErrorResponse,
  apiErrorResponse
} from "@/modules/platform-api/contracts/errors";
import { projectPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };

async function close(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.GATE_APPROVE);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, archiveCloseBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const result = await closeProject({
      projectId: path.projectId,
      archiveVersionId: body.archiveVersionId,
      g9SubmissionId: body.g9SubmissionId,
      expectedProjectVersion: body.expectedProjectVersion,
      actorId: guard.actor.id,
      operationId: body.operationId,
      idempotencyKey
    });
    return Response.json(result, {
      status: 200,
      headers: { "idempotency-replayed": result.idempotent ? "true" : "false" }
    });
  } catch (error) {
    if (error instanceof ProjectCloseError)
      return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
    return apiContractErrorResponse(error) ?? Promise.reject(error);
  }
}

export const POST = withRequestObservability({ module: "projects", operation: "close" }, close);
