import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath, parseQuery } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  procurementOverviewQuerySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";
import { readProjectProcurementOverview } from "@/modules/procurement/application/readiness-service";

type RouteContext = { params: Promise<{ projectId: string }> };

async function getOverview(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const query = parseQuery(request, procurementOverviewQuerySchema);
    const overview = await readProjectProcurementOverview({ projectId: path.projectId });
    const readiness = overview.readiness;
    return Response.json({
      view: query.view,
      status: readiness?.status ?? "EMPTY",
      ...overview,
      readiness
    });
  } catch (error) {
    return apiContractErrorResponse(error) ?? Promise.reject(error);
  }
}

export const GET = withRequestObservability(
  { module: "procurement", operation: "read-procurement-overview" },
  getOverview
);
