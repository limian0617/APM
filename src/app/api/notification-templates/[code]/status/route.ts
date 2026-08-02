import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { setNotificationTemplateEnabled } from "@/modules/notifications/application/notification-template-service";
import { notificationErrorResponse } from "@/modules/notifications/contracts/notification-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";

type RouteContext = { params: Promise<{ code: string }> };

async function setTemplateStatus(request: Request, context: RouteContext) {
  const { code } = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.NOTIFICATION_TEMPLATE_MANAGE,
    AUDIT_OBJECT_TYPES.NOTIFICATION_TEMPLATE,
    code
  );
  if (!guard.authorized) return guard.response;

  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(
        { error: { code: "INVALID_BODY", message: "请求体必须是 JSON 对象。" } },
        { status: 422 }
      );
    }
    const input = body as Record<string, unknown>;
    return Response.json(
      await setNotificationTemplateEnabled({
        code,
        actorId: guard.actor.id,
        expectedVersion: input.version,
        enabled: input.enabled,
        reason: input.reason,
        auditContext: auditContextFromRequest(request, {
          actorId: guard.actor.id,
          reason: typeof input.reason === "string" ? input.reason : null
        })
      })
    );
  } catch (error) {
    const response = notificationErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const PUT = withRequestObservability(
  { module: "notification-templates", operation: "set-status" },
  setTemplateStatus
);
