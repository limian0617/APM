import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import {
  createTechnicalAsset,
  listTechnicalAssets
} from "@/modules/assets/application/technical-asset-service";
import { technicalAssetErrorResponse } from "@/modules/assets/contracts/technical-asset-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath,
  parseQuery
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  createTechnicalAssetBodySchema,
  rndProjectPathSchema,
  technicalAssetQuerySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ rndProjectId: string }> };

function errorResponse(error: unknown): Response | null {
  return apiContractErrorResponse(error) ?? technicalAssetErrorResponse(error);
}

async function listTechnicalAssetsRoute(request: Request, context: RouteContext) {
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
    const query = parseQuery(request, technicalAssetQuerySchema);
    return Response.json(await listTechnicalAssets({ rndProjectId: path.rndProjectId, ...query }));
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}

async function createTechnicalAssetRoute(request: Request, context: RouteContext) {
  const { rndProjectId } = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.TECHNICAL_ASSET_MANAGE,
    AUDIT_OBJECT_TYPES.RND_PROJECT,
    rndProjectId
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(rndProjectPathSchema, { rndProjectId });
    const body = await parseJsonBody(request, createTechnicalAssetBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      departmentId: null,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "assets.technical-asset.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createTechnicalAsset(
          {
            rndProjectId: path.rndProjectId,
            ...body,
            actorId: guard.actor.id,
            auditContext
          },
          transaction
        )
      })
    });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "technical-assets", operation: "list-technical-assets" },
  listTechnicalAssetsRoute
);
export const POST = withRequestObservability(
  { module: "technical-assets", operation: "create-technical-asset" },
  createTechnicalAssetRoute
);
