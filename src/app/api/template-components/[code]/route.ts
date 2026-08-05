import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { saveTemplateComponentDraft } from "@/modules/configuration/application/template-service";
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
  saveTemplateComponentDraftBodySchema,
  templateComponentPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ code: string }> };

async function saveDraft(request: Request, context: RouteContext) {
  const { code } = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONFIGURATION_WRITE,
    AUDIT_OBJECT_TYPES.TEMPLATE_COMPONENT,
    code
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(templateComponentPathSchema, { code });
    const body = await parseJsonBody(request, saveTemplateComponentDraftBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "configuration.template-component.draft.save",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: body.version === 0 ? 201 : 200,
        body: await saveTemplateComponentDraft(
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

export const PUT = withRequestObservability(
  { module: "configuration-templates", operation: "save-component-draft" },
  saveDraft
);
