import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { getAssetRelease } from "@/modules/assets/application/asset-release-service";
import { assetReleaseErrorResponse } from "@/modules/assets/contracts/asset-release-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { assetReleasePathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ technicalAssetId: string; releaseId: string }> };

async function read(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.TECHNICAL_ASSET_READ,
    AUDIT_OBJECT_TYPES.TECHNICAL_ASSET,
    params.technicalAssetId
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(assetReleasePathSchema, params);
    return Response.json(
      await getAssetRelease({
        technicalAssetId: path.technicalAssetId,
        releaseId: path.releaseId,
        actorId: guard.actor.id,
        auditContext: auditContextFromRequest(request, {
          actorId: guard.actor.id,
          reason: "读取资产 Release"
        })
      })
    );
  } catch (error) {
    return (
      apiContractErrorResponse(error) ?? assetReleaseErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "assets", operation: "read-asset-release" },
  read
);
