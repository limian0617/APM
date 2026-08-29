import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { createAcceptanceTemplateVersion } from "@/modules/acceptance/application/acceptance-service";
import {
  acceptanceServiceErrorResponse,
  createAcceptanceTemplateBodySchema
} from "@/modules/acceptance/contracts/acceptance-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import { parseIdempotencyHeaders, parseJsonBody } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";

async function publishTemplate(request: Request) {
  const body = (await request
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONFIGURATION_WRITE,
    AUDIT_OBJECT_TYPES.ACCEPTANCE_TEMPLATE,
    typeof body?.code === "string" ? body.code : null
  );
  if (!guard.authorized) return guard.response;
  try {
    const parsed = await parseJsonBody(request, createAcceptanceTemplateBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "configuration.acceptance-templates.publish",
      idempotencyKey,
      request: { body: parsed },
      execute: async (transaction) => ({
        status: 201,
        body: await createAcceptanceTemplateVersion(
          {
            template: parsed,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              reason: "发布全局 FAT/SAT 验收模板"
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      acceptanceServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "acceptance", operation: "publish-global-template" },
  publishTemplate
);
