import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { publishNotificationTemplate } from "@/modules/notifications/application/notification-template-service";
import { notificationErrorResponse } from "@/modules/notifications/contracts/notification-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";

type RouteContext = { params: Promise<{ code: string }> };

async function publishVersion(request: Request, context: RouteContext) {
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
      await publishNotificationTemplate({
        code,
        actorId: guard.actor.id,
        expectedVersion: input.version,
        subjectTemplate: input.subjectTemplate,
        bodyTextTemplate: input.bodyTextTemplate,
        bodyHtmlTemplate: input.bodyHtmlTemplate,
        variableSchema: input.variableSchema,
        auditContext: auditContextFromRequest(request, { actorId: guard.actor.id })
      }),
      { status: 201 }
    );
  } catch (error) {
    const response = notificationErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const POST = withRequestObservability(
  { module: "notification-templates", operation: "publish-version" },
  publishVersion
);
