import { PERMISSIONS } from "@/lib/auth/permissions";
import { decideAuthorization } from "@/lib/auth/authorize";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import {
  archiveServiceErrorResponse,
  listProjectArchives
} from "@/modules/archives/application/archive-service";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { projectPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };

async function getArchive(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const result = await listProjectArchives({ projectId: path.projectId });
    const closeDecision = decideAuthorization(guard.actor, PERMISSIONS.GATE_APPROVE, {
      projectId: path.projectId,
      resourceDepartmentId: guard.project.departmentId,
      memberRoles: guard.project.memberRoles
    });
    return Response.json({
      ...result,
      allowedActions:
        closeDecision.allowed && result.project.status !== "CLOSED"
          ? ["CLOSE", "GENERATE", "RECHECK"]
          : ["GENERATE", "RECHECK"]
    });
  } catch (error) {
    const response = apiContractErrorResponse(error);
    if (response) return response;
    const archiveResponse = archiveServiceErrorResponse(error);
    if (archiveResponse) return archiveResponse;
    throw error;
  }
}

export const GET = withRequestObservability({ module: "archives", operation: "list" }, getArchive);
