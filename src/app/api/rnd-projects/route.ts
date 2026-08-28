import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { createRndProject } from "@/modules/assets/application/technical-asset-service";
import { technicalAssetErrorResponse } from "@/modules/assets/contracts/technical-asset-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import { parseIdempotencyHeaders, parseJsonBody } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { createRndProjectBodySchema } from "@/modules/platform-api/contracts/internal-routes";

function errorResponse(error: unknown): Response | null {
  return apiContractErrorResponse(error) ?? technicalAssetErrorResponse(error);
}

async function createRndProjectRoute(request: Request) {
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.TECHNICAL_ASSET_MANAGE,
    AUDIT_OBJECT_TYPES.RND_PROJECT
  );
  if (!guard.authorized) return guard.response;
  try {
    const body = await parseJsonBody(request, createRndProjectBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      departmentId: body.departmentId ?? null,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "assets.rnd-project.create",
      idempotencyKey,
      request: { body },
      execute: async (transaction) => ({
        status: 201,
        body: await createRndProject(
          { ...body, actorId: guard.actor.id, auditContext },
          transaction
        )
      })
    });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const POST = withRequestObservability(
  { module: "technical-assets", operation: "create-rnd-project" },
  createRndProjectRoute
);
