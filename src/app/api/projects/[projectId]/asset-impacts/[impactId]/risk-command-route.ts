import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  closeProjectAssetImpact,
  decideProjectAssetImpactRiskAcceptance,
  requestProjectAssetImpactRiskAcceptance
} from "@/modules/assets/application/project-asset-impact-service";
import {
  projectAssetImpactCommandBodySchema,
  projectAssetImpactErrorResponse,
  projectAssetImpactPathSchema,
  projectAssetImpactRiskAcceptancePathSchema
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

type Context = {
  params: Promise<{ projectId: string; impactId: string; requestId?: string }>;
};
type Command = "REQUEST" | "APPROVE" | "REJECT" | "CLOSE";

export function projectAssetImpactRiskCommandRoute(config: {
  command: Command;
  operation: string;
  observabilityOperation: string;
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
      const decisionPath =
        config.command === "APPROVE" || config.command === "REJECT"
          ? parsePath(projectAssetImpactRiskAcceptancePathSchema, params)
          : null;
      const path = decisionPath ?? parsePath(projectAssetImpactPathSchema, params);
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
          body:
            config.command === "REQUEST"
              ? await requestProjectAssetImpactRiskAcceptance(input, transaction)
              : config.command === "CLOSE"
                ? await closeProjectAssetImpact(input, transaction)
                : await decideProjectAssetImpactRiskAcceptance(
                    {
                      ...input,
                      requestId: decisionPath!.requestId,
                      decision: config.command
                    },
                    transaction
                  )
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
