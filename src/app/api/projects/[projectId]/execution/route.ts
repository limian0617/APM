import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { projectPathSchema } from "@/modules/platform-api/contracts/internal-routes";
import { getProjectExecution } from "@/modules/planning/application/project-execution-query";
import { projectExecutionErrorResponse } from "@/modules/planning/contracts/project-execution-http";

type RouteContext = { params: Promise<{ projectId: string }> };

async function readExecution(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    return Response.json(await getProjectExecution(path.projectId));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      projectExecutionErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "planning", operation: "read-project-execution" },
  readExecution
);
