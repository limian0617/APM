import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { updateSystemSetting } from "@/modules/configuration/application/configuration-service";
import { ConfigurationValidationError } from "@/modules/configuration/domain/definitions";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import {
  apiContractErrorResponse,
  apiErrorResponse
} from "@/modules/platform-api/contracts/errors";
import {
  settingBodySchema,
  settingPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ key: string }> };

function errorResponse(error: ConfigurationValidationError): Response {
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}

async function updateSetting(request: Request, context: RouteContext) {
  const { key } = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONFIGURATION_WRITE,
    AUDIT_OBJECT_TYPES.SYSTEM_SETTING,
    key
  );
  if (!guard.authorized) {
    return guard.response;
  }

  try {
    const path = parsePath(settingPathSchema, { key });
    const input = await parseJsonBody(request, settingBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      reason: input.reason
    });
    return idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "configuration.setting.update",
      idempotencyKey,
      request: { path, body: input },
      execute: async (transaction) => ({
        status: 200,
        body: await updateSystemSetting(
          {
            key: path.key,
            value: input.value,
            version: input.version,
            reason: input.reason,
            actorId: guard.actor.id,
            auditContext
          },
          transaction
        )
      })
    });
  } catch (error) {
    const contractResponse = apiContractErrorResponse(error);
    if (contractResponse) return contractResponse;
    if (error instanceof ConfigurationValidationError) {
      return errorResponse(error);
    }
    throw error;
  }
}

export const PUT = withRequestObservability(
  { module: "configuration", operation: "update-setting" },
  updateSetting
);
