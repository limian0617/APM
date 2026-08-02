import { auditContextFromRequest } from "@/modules/audit/application/context";
import { authorizeNotificationRequest } from "@/modules/notifications/application/notification-guard";
import { listNotifications } from "@/modules/notifications/application/notification-service";
import { notificationErrorResponse } from "@/modules/notifications/contracts/notification-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parseQuery } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { notificationQuerySchema } from "@/modules/platform-api/contracts/internal-routes";

async function listInbox(request: Request) {
  const guard = await authorizeNotificationRequest(request);
  if (!guard.authorized) return guard.response;

  try {
    const query = parseQuery(request, notificationQuerySchema);
    return Response.json(
      await listNotifications({
        actor: guard.actor,
        unreadOnly: query.unread,
        cursor: query.cursor,
        limit: query.limit,
        auditContext: auditContextFromRequest(request, { actorId: guard.actor.id })
      })
    );
  } catch (error) {
    const contractResponse = apiContractErrorResponse(error);
    if (contractResponse) return contractResponse;
    const response = notificationErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "notifications", operation: "list-inbox" },
  listInbox
);
