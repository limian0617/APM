import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  findResidualItemParticipantIds,
  submitResidualItemVerification
} from "@/modules/governance/application/gate-conditional-release-service";
import { gateServiceErrorResponse } from "@/modules/governance/contracts/gate-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  residualItemCommandBodySchema,
  residualItemPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string; residualItemId: string }> };

async function submitVerification(request: Request, context: RouteContext) {
  try {
    const path = parsePath(residualItemPathSchema, await context.params);
    const participants = await findResidualItemParticipantIds(path.projectId, path.residualItemId);
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS.TASK_PROGRESS_UPDATE,
      { resourceOwnerId: participants?.ownerUserId }
    );
    if (!guard.authorized) return guard.response;
    const body = await parseJsonBody(request, residualItemCommandBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.residual-item.submit-verification",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await submitResidualItemVerification(
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
      apiContractErrorResponse(error) ?? gateServiceErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "governance", operation: "submit-residual-item-verification" },
  submitVerification
);
