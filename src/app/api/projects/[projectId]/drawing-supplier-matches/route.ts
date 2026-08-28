import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { listSupplierMatches } from "@/modules/drawings/application/supplier-manufacturing-capability-service";
import { manufacturingClassificationErrorResponse } from "@/modules/drawings/contracts/manufacturing-classification-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath, parseQuery } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  drawingSupplierMatchQuerySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };

async function listProjectDrawingSupplierMatches(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const query = parseQuery(request, drawingSupplierMatchQuerySchema);
    return Response.json(
      await listSupplierMatches({
        projectId: path.projectId,
        categoryCode: query.categoryCode,
        processTagCodes: query.processTagCodes
      })
    );
  } catch (error) {
    const response =
      apiContractErrorResponse(error) ?? manufacturingClassificationErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "drawings", operation: "list-project-drawing-supplier-matches" },
  listProjectDrawingSupplierMatches
);
