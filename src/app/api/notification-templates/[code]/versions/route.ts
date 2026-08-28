import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { publishNotificationTemplate } from "@/modules/notifications/application/notification-template-service";
import { notificationErrorResponse } from "@/modules/notifications/contracts/notification-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  notificationTemplatePathSchema,
  publishNotificationTemplateBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

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
    const path = parsePath(notificationTemplatePathSchema, { code });
    const input = await parseJsonBody(request, publishNotificationTemplateBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "notifications.template.publish",
      idempotencyKey,
      request: { path, body: input },
      execute: async (transaction) => ({
        status: 201,
        body: await publishNotificationTemplate(
          {
            code: path.code,
            actorId: guard.actor.id,
            expectedVersion: input.version,
            subjectTemplate: input.subjectTemplate,
            bodyTextTemplate: input.bodyTextTemplate,
            bodyHtmlTemplate: input.bodyHtmlTemplate,
            variableSchema: input.variableSchema,
            auditContext: auditContextFromRequest(request, { actorId: guard.actor.id })
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
  { module: "notification-templates", operation: "publish-version" },
  publishVersion
);
