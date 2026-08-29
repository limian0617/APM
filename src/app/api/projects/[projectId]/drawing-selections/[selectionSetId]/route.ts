import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { getDrawingSelectionSet } from "@/modules/drawings/application/drawing-selection-service";
import { manufacturingClassificationErrorResponse } from "@/modules/drawings/contracts/manufacturing-classification-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { drawingSelectionSetPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string; selectionSetId: string }> };

async function getSelectionSet(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(drawingSelectionSetPathSchema, params);
    return Response.json(await getDrawingSelectionSet(path));
  } catch (error) {
    const response =
      apiContractErrorResponse(error) ?? manufacturingClassificationErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "drawings", operation: "get-drawing-selection-set" },
  getSelectionSet
);
