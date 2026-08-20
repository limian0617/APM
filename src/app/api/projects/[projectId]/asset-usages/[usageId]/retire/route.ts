import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  recordProjectAssetCommandFailure,
  retireProjectAssetUsage
} from "@/modules/assets/application/project-asset-usage-service";
import {
  projectAssetRetireBodySchema,
  projectAssetUsageErrorResponse
} from "@/modules/assets/contracts/project-asset-usage-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import { projectAssetUsagePathSchema } from "@/modules/platform-api/contracts/internal-routes";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  assertIfMatchMatches,
  parseIdempotencyHeaders,
  parseIfMatchHeader,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";

type Context = { params: Promise<{ projectId: string; usageId: string }> };
export const POST = withRequestObservability(
  { module: "assets", operation: "retire-project-asset-usage" },
  async (request: Request, context: Context) => {
    const { projectId, usageId } = await context.params;
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
      reason: "project asset usage retire failed"
    });
    try {
      const path = parsePath(projectAssetUsagePathSchema, { projectId, usageId });
      const body = await parseJsonBody(request, projectAssetRetireBodySchema);
      assertIfMatchMatches(parseIfMatchHeader(request), body.version, "version");
      const { idempotencyKey } = parseIdempotencyHeaders(request);
      return await idempotentCommandResponse({
        actorId: guard.actor.id,
        operation: "projects.asset-usage.retire",
        idempotencyKey,
        request: { path, body },
        execute: async (transaction) => ({
          status: 200,
          body: await retireProjectAssetUsage(
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
        action: "PROJECT_ASSET_USAGE_RETIRED",
        objectType: "PROJECT_ASSET_USAGE",
        objectId: usageId,
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
