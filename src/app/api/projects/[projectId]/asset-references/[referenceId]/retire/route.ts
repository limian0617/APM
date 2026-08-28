import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  recordProjectAssetCommandFailure,
  retireProjectAssetReference
} from "@/modules/assets/application/project-asset-usage-service";
import {
  projectAssetRetireBodySchema,
  projectAssetUsageErrorResponse
} from "@/modules/assets/contracts/project-asset-usage-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import { projectAssetReferencePathSchema } from "@/modules/platform-api/contracts/internal-routes";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  assertIfMatchMatches,
  parseIdempotencyHeaders,
  parseIfMatchHeader,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";

type Context = { params: Promise<{ projectId: string; referenceId: string }> };
export const POST = withRequestObservability(
  { module: "assets", operation: "retire-project-asset-reference" },
  async (request: Request, context: Context) => {
    const { projectId, referenceId } = await context.params;
    const guard = await authorizeProjectRequest(
      request,
      projectId,
      PERMISSIONS.PROJECT_ASSET_USAGE_MANAGE,
      { requireProjectMembership: true }
    );
    if (!guard.authorized) return guard.response;
    const assetReadGuard = await authorizeProjectRequest(
      request,
      projectId,
      PERMISSIONS.TECHNICAL_ASSET_READ,
      { requireProjectMembership: true }
    );
    if (!assetReadGuard.authorized) return assetReadGuard.response;
    const failureAuditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId,
      departmentId: guard.project.departmentId,
      reason: "project asset reference retire failed"
    });
    try {
      const path = parsePath(projectAssetReferencePathSchema, { projectId, referenceId });
      const body = await parseJsonBody(request, projectAssetRetireBodySchema);
      assertIfMatchMatches(parseIfMatchHeader(request), body.version, "version");
      const { idempotencyKey } = parseIdempotencyHeaders(request);
      return await idempotentCommandResponse({
        actorId: guard.actor.id,
        operation: "projects.asset-reference.retire",
        idempotencyKey,
        request: { path, body },
        execute: async (transaction) => ({
          status: 200,
          body: await retireProjectAssetReference(
            {
              ...path,
              ...body,
              actorId: guard.actor.id,
              authorizationActor: guard.actor,
              auditContext: auditContextFromRequest(request, {
                actorId: guard.actor.id,
                projectId,
                departmentId: guard.project.departmentId,
                reason: body.reason
              })
            },
            transaction
          )
        })
      });
    } catch (error) {
      await recordProjectAssetCommandFailure({
        action: "PROJECT_ASSET_REFERENCE_RETIRED",
        objectType: "PROJECT_ASSET_REFERENCE",
        objectId: referenceId,
        projectId,
        context: failureAuditContext,
        error
      });
      const response = apiContractErrorResponse(error) ?? projectAssetUsageErrorResponse(error);
      if (response) return response;
      throw error;
    }
  }
);
