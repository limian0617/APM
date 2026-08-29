import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath, parseQuery } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { projectPathSchema } from "@/modules/platform-api/contracts/internal-routes";
import { listProcurementChangeImpacts } from "@/modules/procurement/application/change-impact-service";
import {
  procurementChangeImpactQuerySchema,
  procurementServiceErrorResponse
} from "@/modules/procurement/contracts/procurement-http";

type RouteContext = { params: Promise<{ projectId: string }> };

async function listChangeImpacts(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const query = parseQuery(request, procurementChangeImpactQuerySchema);
    return Response.json(
      await listProcurementChangeImpacts({ projectId: path.projectId, ...query })
    );
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      procurementServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "procurement", operation: "list-procurement-change-impacts" },
  listChangeImpacts
);
