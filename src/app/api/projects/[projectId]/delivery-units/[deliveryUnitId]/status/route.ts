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
  deliveryUnitPathSchema,
  deliveryUnitStatusBodySchema
} from "@/modules/platform-api/contracts/internal-routes";
import { setDeliveryUnitEnabled } from "@/modules/projects/application/project-structure";
import { projectStructureErrorResponse } from "@/modules/projects/contracts/project-http";

type RouteContext = {
  params: Promise<{ projectId: string; deliveryUnitId: string }>;
};

async function changeDeliveryUnitStatus(request: Request, context: RouteContext) {
  const { projectId, deliveryUnitId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_PLAN_UPDATE);
  if (!guard.authorized) return guard.response;

  try {
    const path = parsePath(deliveryUnitPathSchema, { projectId, deliveryUnitId });
    const body = await parseJsonBody(request, deliveryUnitStatusBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.delivery-unit.status",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await setDeliveryUnitEnabled(
          {
            projectId: path.projectId,
            deliveryUnitId: path.deliveryUnitId,
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
      projectStructureErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "projects", operation: "delivery-unit-status" },
  changeDeliveryUnitStatus
);
