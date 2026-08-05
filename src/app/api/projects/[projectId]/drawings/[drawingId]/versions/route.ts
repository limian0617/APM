import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { createMechanicalDrawingDraft } from "@/modules/drawings/application/mechanical-drawing-service";
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
  createMechanicalDrawingVersionBodySchema,
  mechanicalDrawingPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string; drawingId: string }> };

async function createDrawingVersion(request: Request, context: RouteContext) {
  const { projectId, drawingId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_MANAGE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(mechanicalDrawingPathSchema, { projectId, drawingId });
    const body = await parseJsonBody(request, createMechanicalDrawingVersionBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const contextValue = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.mechanical-drawing.draft-version",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createMechanicalDrawingDraft(
          {
            ...path,
            ...body,
            actorId: guard.actor.id,
            auditContext: contextValue,
            sourceFileAccess: { actor: guard.actor, project: guard.project }
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
  { module: "drawings", operation: "create-mechanical-drawing-version" },
  createDrawingVersion
);
