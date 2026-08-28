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
  closePlanningBodySchema,
  planningTaskCommandPathSchema,
  planningTaskProgressBodySchema
} from "@/modules/platform-api/contracts/internal-routes";
import {
  closePlanningTask,
  planningTaskOwnerUserId,
  updatePlanningTaskProgress
} from "@/modules/planning/application/planning-service";
import { planningErrorResponse } from "@/modules/planning/contracts/planning-http";

type RouteContext = {
  params: Promise<{ projectId: string; taskId: string; command: string }>;
};

async function commandTask(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    const path = parsePath(planningTaskCommandPathSchema, params);
    const ownerUserId =
      path.command === "progress"
        ? await planningTaskOwnerUserId(path.projectId, path.taskId)
        : null;
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      path.command === "progress"
        ? PERMISSIONS.TASK_PROGRESS_UPDATE
        : PERMISSIONS.PROJECT_PLAN_UPDATE,
      path.command === "progress" ? { resourceOwnerId: ownerUserId } : {}
    );
    if (!guard.authorized) return guard.response;
    const { idempotencyKey } = parseIdempotencyHeaders(request);

    if (path.command === "progress") {
      const body = await parseJsonBody(request, planningTaskProgressBodySchema);
      return await idempotentCommandResponse({
        actorId: guard.actor.id,
        operation: "planning.task.progress",
        idempotencyKey,
        request: { path, body },
        execute: async (transaction) => ({
          status: 200,
          body: await updatePlanningTaskProgress(
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
    }

    const body = await parseJsonBody(request, closePlanningBodySchema);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "planning.task.close",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await closePlanningTask(
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

export const POST = withRequestObservability(
  { module: "planning", operation: "command-task" },
  commandTask
);
