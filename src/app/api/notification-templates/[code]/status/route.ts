import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { setNotificationTemplateEnabled } from "@/modules/notifications/application/notification-template-service";
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
  notificationTemplateStatusBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

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
    const path = parsePath(notificationTemplatePathSchema, { code });
    const input = await parseJsonBody(request, notificationTemplateStatusBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "notifications.template.status",
      idempotencyKey,
      request: { path, body: input },
      execute: async (transaction) => ({
        status: 200,
        body: await setNotificationTemplateEnabled(
          {
            code: path.code,
            actorId: guard.actor.id,
            expectedVersion: input.version,
            enabled: input.enabled,
            reason: input.reason,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              reason: input.reason
            })
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

export const PUT = withRequestObservability(
  { module: "notification-templates", operation: "set-status" },
  setTemplateStatus
);
