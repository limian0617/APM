import { PERMISSIONS } from "@/lib/auth/permissions";
import { decideAuthorization } from "@/lib/auth/authorize";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import {
  createAssetReleaseRecall,
  listAssetReleaseRecalls
} from "@/modules/assets/application/asset-upgrade-impact-service";
import {
  assetReleaseRecallCollectionPathSchema,
  assetReleaseRecallCreateBodySchema,
  assetReleaseRecallQuerySchema,
  assetUpgradeImpactErrorResponse
} from "@/modules/assets/contracts/asset-upgrade-impact-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  assertIfMatchMatches,
  parseIdempotencyHeaders,
  parseIfMatchHeader,
  parseJsonBody,
  parsePath,
  parseQuery
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";

type RouteContext = {
  params: Promise<{ technicalAssetId: string; releaseId: string }>;
};

const errorResponse = (error: unknown) =>
  apiContractErrorResponse(error) ?? assetUpgradeImpactErrorResponse(error);

async function list(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.TECHNICAL_ASSET_READ,
    AUDIT_OBJECT_TYPES.TECHNICAL_ASSET,
    params.technicalAssetId
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(assetReleaseRecallCollectionPathSchema, params);
    const canManage = decideAuthorization(guard.actor, PERMISSIONS.TECHNICAL_ASSET_MANAGE).allowed;
    return Response.json(
      await listAssetReleaseRecalls({
        ...path,
        ...parseQuery(request, assetReleaseRecallQuerySchema),
        actorId: guard.actor.id,
        canManage,
        auditContext: auditContextFromRequest(request, {
          actorId: guard.actor.id,
          reason: "读取资产召回"
        })
      })
    );
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}

async function create(request: Request, context: RouteContext) {
  const params = await context.params;
  const readGuard = await authorizeSystemRequest(
    request,
    PERMISSIONS.TECHNICAL_ASSET_READ,
    AUDIT_OBJECT_TYPES.TECHNICAL_ASSET,
    params.technicalAssetId
  );
  if (!readGuard.authorized) return readGuard.response;
  const manageGuard = await authorizeSystemRequest(
    request,
    PERMISSIONS.TECHNICAL_ASSET_MANAGE,
    AUDIT_OBJECT_TYPES.TECHNICAL_ASSET,
    params.technicalAssetId
  );
  if (!manageGuard.authorized) return manageGuard.response;
  try {
    const path = parsePath(assetReleaseRecallCollectionPathSchema, params);
    const body = await parseJsonBody(request, assetReleaseRecallCreateBodySchema);
    assertIfMatchMatches(
      parseIfMatchHeader(request),
      body.releaseResourceVersion,
      "releaseResourceVersion"
    );
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: manageGuard.actor.id,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: manageGuard.actor.id,
      operation: "assets.release-recall.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createAssetReleaseRecall(
          {
            ...path,
            ...body,
            actorId: manageGuard.actor.id,
            authorizationActor: manageGuard.actor,
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
  { module: "assets", operation: "list-asset-release-recalls" },
  list
);
export const POST = withRequestObservability(
  { module: "assets", operation: "create-asset-release-recall" },
  create
);
