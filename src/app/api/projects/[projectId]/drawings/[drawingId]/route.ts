import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { getMechanicalDrawing } from "@/modules/drawings/application/mechanical-drawing-service";
import { mechanicalDrawingErrorResponse } from "@/modules/drawings/contracts/mechanical-drawing-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { mechanicalDrawingPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string; drawingId: string }> };

async function getDrawing(request: Request, context: RouteContext) {
  const { projectId, drawingId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(mechanicalDrawingPathSchema, { projectId, drawingId });
    return Response.json(
      await getMechanicalDrawing({
        ...path,
        sourceFileAccess: {
          actor: guard.actor,
          project: guard.project,
          auditContext: auditContextFromRequest(request, {
            actorId: guard.actor.id,
            projectId: path.projectId,
            departmentId: guard.project.departmentId
          }),
          method: request.method,
          path: new URL(request.url).pathname
        }
      })
    );
  } catch (error) {
    const response = apiContractErrorResponse(error) ?? mechanicalDrawingErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "drawings", operation: "get-mechanical-drawing" },
  getDrawing
);
