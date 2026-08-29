import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { publishProjectTemplate } from "@/modules/configuration/application/template-service";
import { templateErrorResponse } from "@/modules/configuration/contracts/template-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  projectTemplatePathSchema,
  publishTemplateBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ code: string }> };

async function publish(request: Request, context: RouteContext) {
  const { code } = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONFIGURATION_WRITE,
    AUDIT_OBJECT_TYPES.TEMPLATE,
    code
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectTemplatePathSchema, { code });
    const body = await parseJsonBody(request, publishTemplateBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "configuration.template.publish",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await publishProjectTemplate(
          {
            ...body,
            code: path.code,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              reason: body.reason
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    return apiContractErrorResponse(error) ?? templateErrorResponse(error) ?? Promise.reject(error);
  }
}

export const POST = withRequestObservability(
  { module: "configuration-templates", operation: "publish-template" },
  publish
);
