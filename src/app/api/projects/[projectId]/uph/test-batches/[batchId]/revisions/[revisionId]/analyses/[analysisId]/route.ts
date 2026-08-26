import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { getUphAnalysis } from "@/modules/uph/application/uph-analysis-service";
import { uphApiErrorResponse } from "@/modules/uph/application/uph-api-errors";
import { uphAnalysisDetailPathSchema } from "@/modules/uph/contracts/uph-analysis-http";

type Context = {
  params: Promise<{ projectId: string; batchId: string; revisionId: string; analysisId: string }>;
};

async function get(request: Request, context: Context) {
  try {
    const raw = await context.params;
    const path = parsePath(uphAnalysisDetailPathSchema, raw);
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS.PROJECT_UPH_READ,
      { requireProjectMembership: true }
    );
    if (!guard.authorized) return guard.response;

    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: null
    });
    return Response.json(
      await getUphAnalysis({
        ...path,
        actorId: guard.actor.id,
        authorizationActor: guard.actor,
        projectMemberRoles: guard.project.memberRoles,
        auditContext
      })
    );
  } catch (error) {
    return uphApiErrorResponse(error) ?? Promise.reject(error);
  }
}

export const GET = withRequestObservability({ module: "uph", operation: "get-analysis" }, get);
