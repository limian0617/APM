import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { planningChangePathSchema } from "@/modules/platform-api/contracts/internal-routes";
import { getPlanningChange } from "@/modules/planning/application/planning-change-service";
import { planningChangeErrorResponse } from "@/modules/planning/contracts/planning-http";

type RouteContext = { params: Promise<{ projectId: string; changeId: string }> };

async function readChange(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(request, params.projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(planningChangePathSchema, params);
    return Response.json(await getPlanningChange(path.projectId, path.changeId));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ?? planningChangeErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "planning", operation: "read-planning-change" },
  readChange
);
