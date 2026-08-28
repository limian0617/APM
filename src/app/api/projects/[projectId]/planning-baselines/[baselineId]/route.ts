import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { getPlanningBaseline } from "@/modules/planning/application/planning-baseline-service";
import { planningBaselineErrorResponse } from "@/modules/planning/contracts/planning-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { planningBaselinePathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string; baselineId: string }> };

async function readBaseline(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(request, params.projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(planningBaselinePathSchema, params);
    return Response.json(await getPlanningBaseline(path.projectId, path.baselineId));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      planningBaselineErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "planning", operation: "read-planning-baseline" },
  readBaseline
);
