import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  adoptProjectAssetUpgrade,
  recordAssetUpgradeAdoptionFailure
} from "@/modules/assets/application/asset-upgrade-adoption-service";
import {
  assetUpgradeImpactErrorResponse,
  projectAssetUpgradeAdoptionBodySchema
} from "@/modules/assets/contracts/asset-upgrade-impact-http";
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
import { projectPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type Context = { params: Promise<{ projectId: string }> };

async function adopt(request: Request, context: Context) {
  const params = await context.params;
  const manageGuard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_ASSET_USAGE_MANAGE,
    { requireProjectMembership: true }
  );
  if (!manageGuard.authorized) return manageGuard.response;
  const assetReadGuard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.TECHNICAL_ASSET_READ,
    { requireProjectMembership: true }
  );
  if (!assetReadGuard.authorized) return assetReadGuard.response;
  const failureAuditContext = auditContextFromRequest(request, {
    actorId: manageGuard.actor.id,
    projectId: params.projectId,
    departmentId: manageGuard.project.departmentId,
    reason: "project asset upgrade adoption failed"
  });
  try {
    const path = parsePath(projectPathSchema, params);
    const body = await parseJsonBody(request, projectAssetUpgradeAdoptionBodySchema);
    assertIfMatchMatches(
      parseIfMatchHeader(request),
      body.sourceReferenceVersion,
      "sourceReferenceVersion"
    );
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: manageGuard.actor.id,
      operation: "projects.asset-upgrade.adopt",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await adoptProjectAssetUpgrade(
          {
            ...path,
            ...body,
            actorId: manageGuard.actor.id,
            authorizationActor: manageGuard.actor,
            auditContext: auditContextFromRequest(request, {
              actorId: manageGuard.actor.id,
              projectId: path.projectId,
              departmentId: manageGuard.project.departmentId,
              reason: body.reason
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    await recordAssetUpgradeAdoptionFailure({
      projectId: params.projectId,
      objectId: params.projectId,
      context: failureAuditContext,
      error
    });
    return (
      apiContractErrorResponse(error) ??
      assetUpgradeImpactErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "assets", operation: "adopt-project-asset-upgrade" },
  adopt
);
