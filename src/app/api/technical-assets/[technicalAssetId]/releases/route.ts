import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { createAssetRelease } from "@/modules/assets/application/asset-release-service";
import { assetReleaseErrorResponse } from "@/modules/assets/contracts/asset-release-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  assetReleaseCollectionPathSchema,
  createAssetReleaseBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ technicalAssetId: string }> };

async function create(request: Request, context: RouteContext) {
  const { technicalAssetId } = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.TECHNICAL_ASSET_MANAGE,
    AUDIT_OBJECT_TYPES.TECHNICAL_ASSET,
    technicalAssetId
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(assetReleaseCollectionPathSchema, { technicalAssetId });
    const body = await parseJsonBody(request, createAssetReleaseBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "assets.asset-release.create",
      idempotencyKey,
      request: { technicalAssetId: path.technicalAssetId, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createAssetRelease(
          {
            technicalAssetId: path.technicalAssetId,
            ...body,
            reason: body.reason,
            actorId: guard.actor.id,
            auditContext
          },
          transaction
        )
      })
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ?? assetReleaseErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "assets", operation: "create-asset-release" },
  create
);
