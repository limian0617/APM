import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { projectPathSchema } from "@/modules/platform-api/contracts/internal-routes";
import { listProjectStages } from "@/modules/projects/application/project-stage-service";
import { projectStageErrorResponse } from "@/modules/projects/contracts/project-stage-http";

type RouteContext = { params: Promise<{ projectId: string }> };

async function listStages(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    return Response.json(await listProjectStages(path.projectId));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ?? projectStageErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "projects", operation: "list-project-stages" },
  listStages
);
