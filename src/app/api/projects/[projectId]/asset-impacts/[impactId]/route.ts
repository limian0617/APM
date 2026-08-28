import { decideAuthorization } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { getProjectAssetImpact } from "@/modules/assets/application/project-asset-impact-service";
import {
  projectAssetImpactErrorResponse,
  projectAssetImpactPathSchema
} from "@/modules/assets/contracts/project-asset-impact-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";

type Context = { params: Promise<{ projectId: string; impactId: string }> };

async function get(request: Request, context: Context) {
  const params = await context.params;
  const readGuard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_ASSET_USAGE_READ,
    { requireProjectMembership: true }
  );
  if (!readGuard.authorized) return readGuard.response;
  const assetReadGuard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.TECHNICAL_ASSET_READ,
    { requireProjectMembership: true }
  );
  if (!assetReadGuard.authorized) return assetReadGuard.response;
  try {
    const path = parsePath(projectAssetImpactPathSchema, params);
    const authorizationContext = {
      projectId: path.projectId,
      memberRoles: readGuard.project.memberRoles,
      requireProjectMembership: true
    };
    const canManage =
      decideAuthorization(
        readGuard.actor,
        PERMISSIONS.PROJECT_ASSET_USAGE_MANAGE,
        authorizationContext
      ).allowed &&
      decideAuthorization(readGuard.actor, PERMISSIONS.TECHNICAL_ASSET_READ, authorizationContext)
        .allowed;
    return Response.json(
      await getProjectAssetImpact({
        ...path,
        actorId: readGuard.actor.id,
        authorizationActor: readGuard.actor,
        canManage,
        auditContext: auditContextFromRequest(request, {
          actorId: readGuard.actor.id,
          projectId: path.projectId,
          departmentId: readGuard.project.departmentId,
          reason: "读取项目资产影响明细"
        })
      })
    );
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      projectAssetImpactErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "assets", operation: "get-project-asset-impact" },
  get
);
