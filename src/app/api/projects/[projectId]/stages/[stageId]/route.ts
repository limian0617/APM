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
  projectStagePathSchema,
  projectStageTransitionBodySchema
} from "@/modules/platform-api/contracts/internal-routes";
import { transitionProjectStage } from "@/modules/projects/application/project-stage-service";
import { projectStageErrorResponse } from "@/modules/projects/contracts/project-stage-http";

type RouteContext = { params: Promise<{ projectId: string; stageId: string }> };

async function transitionStage(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_PLAN_UPDATE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectStagePathSchema, params);
    const body = await parseJsonBody(request, projectStageTransitionBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.stage.transition",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await transitionProjectStage(
          {
            projectId: path.projectId,
            stageId: path.stageId,
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
      apiContractErrorResponse(error) ?? projectStageErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

export const PATCH = withRequestObservability(
  { module: "projects", operation: "transition-project-stage" },
  transitionStage
);
