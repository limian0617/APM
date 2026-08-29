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
  procurementFulfillmentEventPathSchema,
  reverseFulfillmentEventBodySchema
} from "@/modules/platform-api/contracts/internal-routes";
import {
  FulfillmentEventServiceError,
  readProcurementFulfillmentEventType,
  requiredFulfillmentPermission,
  reverseProcurementFulfillmentEvent
} from "@/modules/procurement/application/fulfillment-event-service";
import { procurementServiceErrorResponse } from "@/modules/procurement/contracts/procurement-http";

type RouteContext = { params: Promise<{ projectId: string; eventId: string }> };

async function reverseFulfillmentEvent(request: Request, context: RouteContext) {
  const params = await context.params;
  const readGuard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_READ
  );
  if (!readGuard.authorized) return readGuard.response;
  try {
    const path = parsePath(procurementFulfillmentEventPathSchema, params);
    const event = await readProcurementFulfillmentEventType(path);
    if (!event) {
      throw new FulfillmentEventServiceError(
        "PROC_FULFILLMENT_EVENT_NOT_FOUND",
        "履约事件不存在或不属于当前项目。",
        404
      );
    }
    const permission = requiredFulfillmentPermission(event.eventType);
    const commandGuard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS[permission]
    );
    if (!commandGuard.authorized) return commandGuard.response;
    const body = await parseJsonBody(request, reverseFulfillmentEventBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: commandGuard.actor.id,
      operation: "projects.procurement.fulfillment-event.reverse",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await reverseProcurementFulfillmentEvent(
          {
            projectId: path.projectId,
            eventId: path.eventId,
            ...body,
            actorId: commandGuard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: commandGuard.actor.id,
              projectId: path.projectId,
              departmentId: commandGuard.project.departmentId,
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
      procurementServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "procurement", operation: "reverse-fulfillment-event" },
  reverseFulfillmentEvent
);
