import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { updateCompanyCapability } from "@/modules/configuration/application/configuration-service";
import {
  ConfigurationValidationError,
  isCapabilityCode
} from "@/modules/configuration/domain/definitions";
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
  capabilityBodySchema,
  capabilityPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ code: string }> };

async function updateCapability(request: Request, context: RouteContext) {
  const { code } = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONFIGURATION_WRITE,
    AUDIT_OBJECT_TYPES.COMPANY_CAPABILITY,
    code
  );
  if (!guard.authorized) {
    return guard.response;
  }

  try {
    const path = parsePath(capabilityPathSchema, { code });
    if (!isCapabilityCode(path.code)) {
      throw new ConfigurationValidationError("UNKNOWN_CAPABILITY", "公司能力代码不存在。", 404);
    }
    const capabilityCode = path.code;
    const input = await parseJsonBody(request, capabilityBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      reason: input.reason
    });
    return idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "configuration.capability.update",
      idempotencyKey,
      request: { path, body: input },
      execute: async (transaction) => ({
        status: 200,
        body: await updateCompanyCapability(
          {
            code: capabilityCode,
            enabled: input.enabled,
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
      return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
    }
    throw error;
  }
}

export const PUT = withRequestObservability(
  { module: "configuration", operation: "update-capability" },
  updateCapability
);
