import { auditContextFromRequest } from "@/modules/audit/application/context";
import { authorizeNotificationRequest } from "@/modules/notifications/application/notification-guard";
import { listNotifications } from "@/modules/notifications/application/notification-service";
import { notificationErrorResponse } from "@/modules/notifications/contracts/notification-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";

async function listInbox(request: Request) {
  const guard = await authorizeNotificationRequest(request);
  if (!guard.authorized) return guard.response;

  try {
    const url = new URL(request.url);
    const unread = url.searchParams.get("unread");
    if (unread !== null && unread !== "true" && unread !== "false") {
      return Response.json(
        { error: { code: "INVALID_UNREAD", message: "unread 必须是 true 或 false。" } },
        { status: 400 }
      );
    }
    const limitValue = url.searchParams.get("limit");
    const limit = limitValue === null ? 50 : Number(limitValue);
    return Response.json(
      await listNotifications({
        actor: guard.actor,
        unreadOnly: unread === "true",
        cursor: url.searchParams.get("cursor"),
        limit,
        auditContext: auditContextFromRequest(request, { actorId: guard.actor.id })
      })
    );
  } catch (error) {
    const response = notificationErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "notifications", operation: "list-inbox" },
  listInbox
);
