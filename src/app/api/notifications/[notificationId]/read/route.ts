import { auditContextFromRequest } from "@/modules/audit/application/context";
import { authorizeNotificationRequest } from "@/modules/notifications/application/notification-guard";
import { markNotificationRead } from "@/modules/notifications/application/notification-service";
import { notificationErrorResponse } from "@/modules/notifications/contracts/notification-http";

type RouteContext = { params: Promise<{ notificationId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const guard = await authorizeNotificationRequest(request);
  if (!guard.authorized) return guard.response;
  const { notificationId } = await context.params;
  const path = new URL(request.url).pathname;

  try {
    return Response.json(
      await markNotificationRead({
        notificationId,
        actor: guard.actor,
        auditContext: auditContextFromRequest(request, { actorId: guard.actor.id }),
        method: request.method,
        path
      })
    );
  } catch (error) {
    const response = notificationErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
