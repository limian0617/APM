import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { publishMechanicalDrawingVersion } from "@/modules/drawings/application/mechanical-drawing-service";
import { mechanicalDrawingErrorResponse } from "@/modules/drawings/contracts/mechanical-drawing-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  mechanicalDrawingVersionPathSchema,
  publishMechanicalDrawingVersionBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = {
  params: Promise<{ projectId: string; drawingId: string; documentVersionId: string }>;
};

async function publishDrawingVersion(request: Request, context: RouteContext) {
  const { projectId, drawingId, documentVersionId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_MANAGE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(mechanicalDrawingVersionPathSchema, {
      projectId,
      drawingId,
      documentVersionId
    });
    const body = await parseJsonBody(request, publishMechanicalDrawingVersionBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const contextValue = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.mechanical-drawing.publish-version",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await publishMechanicalDrawingVersion(
          {
            ...path,
            ...body,
            actorId: guard.actor.id,
            auditContext: contextValue,
            sourceFileAccess: {
              actor: guard.actor,
              project: guard.project,
              auditContext: contextValue,
              method: request.method,
              path: new URL(request.url).pathname
            }
          },
          transaction
        )
      })
    });
  } catch (error) {
    const response = apiContractErrorResponse(error) ?? mechanicalDrawingErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const POST = withRequestObservability(
  { module: "drawings", operation: "publish-mechanical-drawing-version" },
  publishDrawingVersion
);
