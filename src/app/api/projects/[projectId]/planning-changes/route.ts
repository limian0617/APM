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
  createPlanningChangeBodySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";
import {
  createPlanningChange,
  listPlanningChanges
} from "@/modules/planning/application/planning-change-service";
import { planningChangeErrorResponse } from "@/modules/planning/contracts/planning-http";

type RouteContext = { params: Promise<{ projectId: string }> };

async function listChanges(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    return Response.json(await listPlanningChanges(path.projectId));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ?? planningChangeErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

async function createChange(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_PLAN_UPDATE);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, createPlanningChangeBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "planning.change.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createPlanningChange(
          {
            projectId: path.projectId,
            actorId: guard.actor.id,
            classification: body.classification,
            reason: body.reason,
            planningInputVersion: body.planningInputVersion,
            resultingPlanningInputVersion: body.resultingPlanningInputVersion,
            delta: body.delta,
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
      apiContractErrorResponse(error) ?? planningChangeErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "planning", operation: "list-planning-changes" },
  listChanges
);
export const POST = withRequestObservability(
  { module: "planning", operation: "planning.change.create" },
  createChange
);
