import { loadAuthorizationActor } from "@/lib/auth/repository";
import { readRequestIdentity } from "@/lib/auth/request-identity";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { auditContextFromRequest } from "@/modules/audit/application/context";

import { recordNotificationDenial } from "./notification-service";

export async function authorizeNotificationRequest(request: Request) {
  const identity = readRequestIdentity(request);
  if (!identity.authenticated) {
    return {
      authorized: false as const,
      response: Response.json(
        { error: { code: "UNAUTHENTICATED", message: "需要有效的用户身份。" } },
        { status: 401 }
      )
    };
  }
  const actor = await loadAuthorizationActor(identity.userId);
  if (!actor) {
    return {
      authorized: false as const,
      response: Response.json(
        { error: { code: "IDENTITY_UNKNOWN", message: "用户身份未在 APM 中登记。" } },
        { status: 401 }
      )
    };
  }
  const allowed =
    actor.status === "ACTIVE" &&
    actor.grants.some(({ permission }) => permission === PERMISSIONS.NOTIFICATION_READ);
  if (allowed) return { authorized: true as const, actor };

  const path = new URL(request.url).pathname;
  await recordNotificationDenial({
    actorId: actor.id,
    notificationId: null,
    context: auditContextFromRequest(request, { actorId: actor.id }),
    reason: actor.status === "ACTIVE" ? "PERMISSION_NOT_GRANTED" : "ACTOR_DISABLED",
    method: request.method,
    path
  }).catch(() => undefined);
  return {
    authorized: false as const,
    response: Response.json(
      { error: { code: "FORBIDDEN", message: "当前角色无权访问通知中心。" } },
      { status: 403 }
    )
  };
}
