import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { listProjectAlerts } from "@/modules/governance/application/alert-service";
import { alertServiceErrorResponse } from "@/modules/governance/contracts/alert-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { projectPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };

async function readAlerts(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_ALERT_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    return Response.json(await listProjectAlerts(path.projectId, guard.actor.id));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ?? alertServiceErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "governance", operation: "list-alerts" },
  readAlerts
);
