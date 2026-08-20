import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { publishAssetReleaseVersion } from "@/modules/assets/application/asset-release-service";
import { assetReleaseErrorResponse } from "@/modules/assets/contracts/asset-release-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import {
  ApiContractError,
  apiContractErrorResponse
} from "@/modules/platform-api/contracts/errors";
import {
  assetReleaseVersionPathSchema,
  publishAssetReleaseVersionBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = {
  params: Promise<{ technicalAssetId: string; releaseId: string; version: string }>;
};

async function publish(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.TECHNICAL_ASSET_MANAGE,
    AUDIT_OBJECT_TYPES.TECHNICAL_ASSET,
    params.technicalAssetId
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(assetReleaseVersionPathSchema, params);
    const body = await parseJsonBody(request, publishAssetReleaseVersionBodySchema);
    if (body.releaseVersion !== path.version) {
      throw new ApiContractError("VERSION_PATH_MISMATCH", "Release 版本路径与请求体不一致。", 409);
    }
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "assets.asset-release.publish",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await publishAssetReleaseVersion(
          {
            technicalAssetId: path.technicalAssetId,
            releaseId: path.releaseId,
            version: body.version,
            releaseVersion: path.version,
            actorId: guard.actor.id,
            reason: body.reason,
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
  { module: "assets", operation: "publish-asset-release" },
  publish
);
