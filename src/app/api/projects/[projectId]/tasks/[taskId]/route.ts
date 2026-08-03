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
  planningTaskPathSchema,
  updatePlanningTaskBodySchema
} from "@/modules/platform-api/contracts/internal-routes";
import {
  getPlanningTask,
  updatePlanningTask
} from "@/modules/planning/application/planning-service";
import { planningErrorResponse } from "@/modules/planning/contracts/planning-http";

type RouteContext = { params: Promise<{ projectId: string; taskId: string }> };

async function readTask(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(request, params.projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(planningTaskPathSchema, params);
    return Response.json(await getPlanningTask(path.projectId, path.taskId));
  } catch (error) {
    return apiContractErrorResponse(error) ?? planningErrorResponse(error) ?? Promise.reject(error);
  }
}

async function updateTask(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_PLAN_UPDATE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(planningTaskPathSchema, params);
    const body = await parseJsonBody(request, updatePlanningTaskBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "planning.task.update",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await updatePlanningTask(
          {
            projectId: path.projectId,
            taskId: path.taskId,
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
    return apiContractErrorResponse(error) ?? planningErrorResponse(error) ?? Promise.reject(error);
  }
}

export const GET = withRequestObservability(
  { module: "planning", operation: "read-task" },
  readTask
);
export const PUT = withRequestObservability(
  { module: "planning", operation: "update-task" },
  updateTask
);
