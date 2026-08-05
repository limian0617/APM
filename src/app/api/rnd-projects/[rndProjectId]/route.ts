import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { getRndProject } from "@/modules/assets/application/technical-asset-service";
import { technicalAssetErrorResponse } from "@/modules/assets/contracts/technical-asset-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { rndProjectPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ rndProjectId: string }> };

async function getRndProjectRoute(request: Request, context: RouteContext) {
  const { rndProjectId } = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.TECHNICAL_ASSET_READ,
    AUDIT_OBJECT_TYPES.RND_PROJECT,
    rndProjectId
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(rndProjectPathSchema, { rndProjectId });
    return Response.json(await getRndProject(path));
  } catch (error) {
    const response = apiContractErrorResponse(error) ?? technicalAssetErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "technical-assets", operation: "get-rnd-project" },
  getRndProjectRoute
);
