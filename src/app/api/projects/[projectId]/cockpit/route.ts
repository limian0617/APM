import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { getLatestCockpitProjection } from "@/modules/cockpit/application/cockpit-projection-service";
import { cockpitProjectionErrorResponse } from "@/modules/cockpit/contracts/cockpit-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { projectPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };

async function readCockpit(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    return Response.json(await getLatestCockpitProjection(path.projectId));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      cockpitProjectionErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "cockpit", operation: "read-cockpit" },
  readCockpit
);
