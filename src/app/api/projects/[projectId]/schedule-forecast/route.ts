import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { projectPathSchema } from "@/modules/platform-api/contracts/internal-routes";
import { getProjectScheduleForecast } from "@/modules/planning/application/schedule-recalculation-service";

type RouteContext = { params: Promise<{ projectId: string }> };

async function readScheduleForecast(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    return Response.json(await getProjectScheduleForecast(path.projectId));
  } catch (error) {
    return apiContractErrorResponse(error) ?? Promise.reject(error);
  }
}

export const GET = withRequestObservability(
  { module: "planning", operation: "read-schedule-forecast" },
  readScheduleForecast
);
