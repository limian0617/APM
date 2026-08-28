import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { deactivateTechnicalAsset } from "@/modules/assets/application/technical-asset-service";
import {
  technicalAssetDeactivateBodySchema,
  technicalAssetDeactivatePathSchema,
  technicalAssetErrorResponse
} from "@/modules/assets/contracts/technical-asset-http";
import { projectAssetUsageErrorResponse } from "@/modules/assets/contracts/project-asset-usage-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  assertIfMatchMatches,
  parseIdempotencyHeaders,
  parseIfMatchHeader,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";

type RouteContext = { params: Promise<{ technicalAssetId: string }> };

async function deactivate(request: Request, context: RouteContext) {
  const params = await context.params;
  const readGuard = await authorizeSystemRequest(
    request,
    PERMISSIONS.TECHNICAL_ASSET_READ,
    AUDIT_OBJECT_TYPES.TECHNICAL_ASSET,
    params.technicalAssetId
  );
  if (!readGuard.authorized) return readGuard.response;
  const manageGuard = await authorizeSystemRequest(
    request,
    PERMISSIONS.TECHNICAL_ASSET_MANAGE,
    AUDIT_OBJECT_TYPES.TECHNICAL_ASSET,
    params.technicalAssetId
  );
  if (!manageGuard.authorized) return manageGuard.response;
  try {
    const path = parsePath(technicalAssetDeactivatePathSchema, params);
    const body = await parseJsonBody(request, technicalAssetDeactivateBodySchema);
    assertIfMatchMatches(parseIfMatchHeader(request), body.version, "version");
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: manageGuard.actor.id,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: manageGuard.actor.id,
      operation: "assets.deactivate",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await deactivateTechnicalAsset(
          {
            assetId: path.technicalAssetId,
            ...body,
            actorId: manageGuard.actor.id,
            authorizationActor: manageGuard.actor,
            auditContext
          },
          transaction
        )
      })
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      technicalAssetErrorResponse(error) ??
      projectAssetUsageErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "assets", operation: "deactivate-technical-asset" },
  deactivate
);
