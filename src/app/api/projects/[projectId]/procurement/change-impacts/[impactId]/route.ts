import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { readProcurementChangeImpactDetail } from "@/modules/procurement/application/change-impact-service";
import {
  procurementChangeImpactPathSchema,
  procurementServiceErrorResponse
} from "@/modules/procurement/contracts/procurement-http";

type RouteContext = { params: Promise<{ projectId: string; impactId: string }> };

async function getChangeImpact(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(procurementChangeImpactPathSchema, params);
    return Response.json(await readProcurementChangeImpactDetail(path));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      procurementServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "procurement", operation: "read-procurement-change-impact" },
  getChangeImpact
);
