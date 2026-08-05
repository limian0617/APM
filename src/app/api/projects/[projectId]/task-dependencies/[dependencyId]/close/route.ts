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
  taskDependencyCloseBodySchema,
  taskDependencyPathSchema
} from "@/modules/platform-api/contracts/internal-routes";
import { closeTaskDependency } from "@/modules/planning/application/schedule-network-service";
import { planningErrorResponse } from "@/modules/planning/contracts/planning-http";

type RouteContext = { params: Promise<{ projectId: string; dependencyId: string }> };

async function closeDependency(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_PLAN_UPDATE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(taskDependencyPathSchema, params);
    const body = await parseJsonBody(request, taskDependencyCloseBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "planning.task-dependency.close",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await closeTaskDependency(
          {
            projectId: path.projectId,
            dependencyId: path.dependencyId,
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
  { module: "planning", operation: "close-task-dependency" },
  closeDependency
);
