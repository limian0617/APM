import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  createMechanicalDrawing,
  listMechanicalDrawings
} from "@/modules/drawings/application/mechanical-drawing-service";
import { mechanicalDrawingErrorResponse } from "@/modules/drawings/contracts/mechanical-drawing-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath,
  parseQuery
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  createMechanicalDrawingBodySchema,
  mechanicalDrawingQuerySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };
const errorResponse = (error: unknown) =>
  apiContractErrorResponse(error) ?? mechanicalDrawingErrorResponse(error);

async function listDrawings(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const query = parseQuery(request, mechanicalDrawingQuerySchema);
    return Response.json(
      await listMechanicalDrawings({
        projectId: path.projectId,
        ...query,
        sourceFileAccess: { actor: guard.actor, project: guard.project }
      })
    );
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}

async function createDrawing(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_MANAGE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, createMechanicalDrawingBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const contextValue = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.mechanical-drawing.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createMechanicalDrawing(
          {
            projectId: path.projectId,
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
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "drawings", operation: "list-mechanical-drawings" },
  listDrawings
);
export const POST = withRequestObservability(
  { module: "drawings", operation: "create-mechanical-drawing" },
  createDrawing
);
