import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  findProjectAlertOwnerId,
  transitionProjectAlert
} from "@/modules/governance/application/alert-service";
import {
  alertServiceErrorResponse,
  parseAlertTransitionPayload
} from "@/modules/governance/contracts/alert-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  alertTransitionBodySchema,
  projectAlertPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string; alertId: string }> };

async function transitionAlert(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_ALERT_ACTION,
    async () => ({
      resourceOwnerId: await findProjectAlertOwnerId(params.projectId, params.alertId)
    })
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectAlertPathSchema, params);
    const body = parseAlertTransitionPayload(
      await parseJsonBody(request, alertTransitionBodySchema)
    );
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.alert.transition",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await transitionProjectAlert(
          {
            ...path,
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
      apiContractErrorResponse(error) ?? alertServiceErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

export const PATCH = withRequestObservability(
  { module: "governance", operation: "transition-alert" },
  transitionAlert
);
