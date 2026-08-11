import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import {
  closeProject,
  ProjectCloseError
} from "@/modules/projects/application/project-close-service";
import { archiveCloseBodySchema } from "@/modules/archives/contracts/archive-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
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
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.close",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await closeProject({
          projectId: path.projectId,
          archiveVersionId: body.archiveVersionId,
          g9SubmissionId: body.g9SubmissionId,
          expectedProjectVersion: body.version,
          actorId: guard.actor.id,
          operationId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
          client: transaction
        })
      })
    });
  } catch (error) {
    if (error instanceof ProjectCloseError)
      return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
    return apiContractErrorResponse(error) ?? Promise.reject(error);
  }
}

export const POST = withRequestObservability({ module: "projects", operation: "close" }, close);
