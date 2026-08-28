import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { transitionRndProject } from "@/modules/assets/application/technical-asset-service";
import { technicalAssetErrorResponse } from "@/modules/assets/contracts/technical-asset-http";
import type { RndProjectStatus } from "@/modules/assets/domain/technical-asset";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  rndProjectCommandBodySchema,
  rndProjectCommandPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ rndProjectId: string; command: string }> };

const commandStatuses = {
  "start-development": "IN_DEVELOPMENT",
  "submit-validation": "VALIDATION",
  "return-development": "IN_DEVELOPMENT",
  "submit-release-review": "RELEASE_REVIEW",
  complete: "COMPLETED",
  cancel: "CANCELED"
} as const satisfies Record<string, RndProjectStatus>;

async function transitionRndProjectRoute(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.TECHNICAL_ASSET_MANAGE,
    AUDIT_OBJECT_TYPES.RND_PROJECT,
    params.rndProjectId
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(rndProjectCommandPathSchema, params);
    const body = await parseJsonBody(request, rndProjectCommandBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: `assets.rnd-project.${path.command}`,
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await transitionRndProject(
          {
            rndProjectId: path.rndProjectId,
            ...body,
            toStatus: commandStatuses[path.command],
            actorId: guard.actor.id,
            auditContext
          },
          transaction
        )
      })
    });
  } catch (error) {
    const response = apiContractErrorResponse(error) ?? technicalAssetErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const POST = withRequestObservability(
  { module: "technical-assets", operation: "transition-rnd-project" },
  transitionRndProjectRoute
);
