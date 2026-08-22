import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  recordProjectAssetImpactDisposition,
  refreshProjectAssetImpact
} from "@/modules/assets/application/project-asset-impact-service";
import {
  projectAssetImpactCommandBodySchema,
  projectAssetImpactErrorResponse,
  projectAssetImpactPathSchema
} from "@/modules/assets/contracts/project-asset-impact-http";
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

type Context = { params: Promise<{ projectId: string; impactId: string }> };
type DispositionAction = "ACKNOWLEDGE" | "START_ASSESSMENT" | "PLAN_UPGRADE";

export function projectAssetImpactCommandRoute(config: {
  operation: string;
  observabilityOperation: string;
  action?: DispositionAction;
}) {
  async function command(request: Request, context: Context) {
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
    try {
      const path = parsePath(projectAssetImpactPathSchema, params);
      const body = await parseJsonBody(request, projectAssetImpactCommandBodySchema);
      assertIfMatchMatches(parseIfMatchHeader(request), body.version, "version");
      const { idempotencyKey } = parseIdempotencyHeaders(request);
      const input = {
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
      };
      return await idempotentCommandResponse({
        actorId: manageGuard.actor.id,
        operation: config.operation,
        idempotencyKey,
        request: { path, body },
        execute: async (transaction) => ({
          status: 201,
          body: config.action
            ? await recordProjectAssetImpactDisposition(
                { ...input, action: config.action },
                transaction
              )
            : await refreshProjectAssetImpact(input, transaction)
        })
      });
    } catch (error) {
      return (
        apiContractErrorResponse(error) ??
        projectAssetImpactErrorResponse(error) ??
        Promise.reject(error)
      );
    }
  }

  return withRequestObservability(
    { module: "assets", operation: config.observabilityOperation },
    command
  );
}
