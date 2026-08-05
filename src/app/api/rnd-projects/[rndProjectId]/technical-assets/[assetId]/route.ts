import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { getTechnicalAsset } from "@/modules/assets/application/technical-asset-service";
import { technicalAssetErrorResponse } from "@/modules/assets/contracts/technical-asset-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { technicalAssetPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ rndProjectId: string; assetId: string }> };

async function getTechnicalAssetRoute(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.TECHNICAL_ASSET_READ,
    AUDIT_OBJECT_TYPES.TECHNICAL_ASSET,
    params.assetId
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(technicalAssetPathSchema, params);
    return Response.json(await getTechnicalAsset(path));
  } catch (error) {
    const response = apiContractErrorResponse(error) ?? technicalAssetErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "technical-assets", operation: "get-technical-asset" },
  getTechnicalAssetRoute
);
