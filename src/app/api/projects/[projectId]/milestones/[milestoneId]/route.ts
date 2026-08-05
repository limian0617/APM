import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  projectMilestonePathSchema,
  updateProjectMilestoneBodySchema
} from "@/modules/platform-api/contracts/internal-routes";
import {
  getProjectMilestone,
  updateProjectMilestone
} from "@/modules/projects/application/milestone-service";
import { projectExecutionErrorResponse } from "@/modules/planning/contracts/project-execution-http";

type RouteContext = { params: Promise<{ projectId: string; milestoneId: string }> };

async function readMilestone(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(request, params.projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectMilestonePathSchema, params);
    return Response.json(await getProjectMilestone(path.projectId, path.milestoneId));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      projectExecutionErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

async function editMilestone(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_PLAN_UPDATE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectMilestonePathSchema, params);
    const body = await parseJsonBody(request, updateProjectMilestoneBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.milestone.update",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await updateProjectMilestone(
          {
            projectId: path.projectId,
            milestoneId: path.milestoneId,
            ...body,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: body.reason
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      projectExecutionErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "projects", operation: "read-project-milestone" },
  readMilestone
);
export const PUT = withRequestObservability(
  { module: "projects", operation: "update-project-milestone" },
  editMilestone
);
