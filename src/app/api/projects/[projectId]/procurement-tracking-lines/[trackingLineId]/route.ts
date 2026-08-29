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
  procurementTrackingLinePathSchema,
  updateProcurementTrackingLineBodySchema
} from "@/modules/platform-api/contracts/internal-routes";
import { updateLocalProcurementTrackingLine } from "@/modules/procurement/application/procurement-tracking-service";
import { procurementServiceErrorResponse } from "@/modules/procurement/contracts/procurement-http";

type RouteContext = { params: Promise<{ projectId: string; trackingLineId: string }> };

async function updateTrackingLine(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_TRACKING_MANAGE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(procurementTrackingLinePathSchema, params);
    const body = await parseJsonBody(request, updateProcurementTrackingLineBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.procurement-tracking-lines.update",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await updateLocalProcurementTrackingLine(
          {
            ...body,
            projectId: path.projectId,
            trackingLineId: path.trackingLineId,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      procurementServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const PUT = withRequestObservability(
  { module: "procurement", operation: "update-tracking-line" },
  updateTrackingLine
);
