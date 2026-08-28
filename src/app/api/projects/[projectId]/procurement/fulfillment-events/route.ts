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
  appendFulfillmentEventBodySchema,
  fulfillmentEventQuerySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";
import {
  appendProcurementFulfillmentEvent,
  listProcurementFulfillmentEvents,
  requiredFulfillmentPermission
} from "@/modules/procurement/application/fulfillment-event-service";
import { procurementServiceErrorResponse } from "@/modules/procurement/contracts/procurement-http";

type RouteContext = { params: Promise<{ projectId: string }> };

async function listFulfillmentEvents(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const query = parseQuery(request, fulfillmentEventQuerySchema);
    return Response.json(
      await listProcurementFulfillmentEvents({ projectId: path.projectId, ...query })
    );
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      procurementServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

async function appendFulfillmentEvent(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  // Authenticate and establish project membership before parsing a potentially malformed command.
  const readGuard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_READ
  );
  if (!readGuard.authorized) return readGuard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, appendFulfillmentEventBodySchema);
    const permission = requiredFulfillmentPermission(body.eventType);
    const commandGuard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS[permission]
    );
    if (!commandGuard.authorized) return commandGuard.response;
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: commandGuard.actor.id,
      operation: "projects.procurement.fulfillment-event.record",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await appendProcurementFulfillmentEvent(
          {
            projectId: path.projectId,
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

export const GET = withRequestObservability(
  { module: "procurement", operation: "list-fulfillment-events" },
  listFulfillmentEvents
);
export const POST = withRequestObservability(
  { module: "procurement", operation: "append-fulfillment-event" },
  appendFulfillmentEvent
);
