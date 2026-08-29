import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath,
  parseQuery
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  createTaskDependencyBodySchema,
  projectPathSchema,
  taskDependencyQuerySchema
} from "@/modules/platform-api/contracts/internal-routes";
import {
  createTaskDependency,
  listTaskDependencies
} from "@/modules/planning/application/schedule-network-service";
import { planningErrorResponse } from "@/modules/planning/contracts/planning-http";

type RouteContext = { params: Promise<{ projectId: string }> };

async function listDependencies(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const query = parseQuery(request, taskDependencyQuerySchema);
    return Response.json(await listTaskDependencies({ projectId: path.projectId, ...query }));
  } catch (error) {
    return apiContractErrorResponse(error) ?? planningErrorResponse(error) ?? Promise.reject(error);
  }
}

async function createDependency(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_PLAN_UPDATE);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, createTaskDependencyBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "planning.task-dependency.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createTaskDependency(
          {
            projectId: path.projectId,
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
  { module: "planning", operation: "list-task-dependencies" },
  listDependencies
);
export const POST = withRequestObservability(
  { module: "planning", operation: "create-task-dependency" },
  createDependency
);
