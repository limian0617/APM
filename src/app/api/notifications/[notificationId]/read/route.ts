import { auditContextFromRequest } from "@/modules/audit/application/context";
import { authorizeNotificationRequest } from "@/modules/notifications/application/notification-guard";
import { markNotificationRead } from "@/modules/notifications/application/notification-service";
import { notificationErrorResponse } from "@/modules/notifications/contracts/notification-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import { parseIdempotencyHeaders, parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { notificationPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ notificationId: string }> };

async function markRead(request: Request, context: RouteContext) {
  const guard = await authorizeNotificationRequest(request);
  if (!guard.authorized) return guard.response;
  const { notificationId } = await context.params;
  const path = new URL(request.url).pathname;

  try {
    const routePath = parsePath(notificationPathSchema, { notificationId });
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "notifications.inbox.mark-read",
      idempotencyKey,
      request: { path: routePath },
      execute: async (transaction) => ({
        status: 200,
        body: await markNotificationRead(
          {
            notificationId: routePath.notificationId,
            actor: guard.actor,
            auditContext: auditContextFromRequest(request, { actorId: guard.actor.id }),
            method: request.method,
            path
          },
          transaction
        )
      })
    });
  } catch (error) {
    const contractResponse = apiContractErrorResponse(error);
    if (contractResponse) return contractResponse;
    const response = notificationErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const POST = withRequestObservability(
  { module: "notifications", operation: "mark-read" },
  markRead
);
