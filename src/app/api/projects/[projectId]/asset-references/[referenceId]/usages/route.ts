import { PERMISSIONS } from "@/lib/auth/permissions";
import { decideAuthorization } from "@/lib/auth/authorize";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  createProjectAssetUsage,
  listProjectAssetUsages,
  recordProjectAssetCommandFailure
} from "@/modules/assets/application/project-asset-usage-service";
import {
  projectAssetUsageCreateBodySchema,
  projectAssetUsageErrorResponse
} from "@/modules/assets/contracts/project-asset-usage-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  projectAssetReferencePathSchema,
  projectAssetUsageQuerySchema
} from "@/modules/platform-api/contracts/internal-routes";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  assertIfMatchMatches,
  parseIdempotencyHeaders,
  parseIfMatchHeader,
  parseJsonBody,
  parsePath,
  parseQuery
} from "@/modules/platform-api/contracts/dto";

type Context = { params: Promise<{ projectId: string; referenceId: string }> };
const errorResponse = (error: unknown) =>
  apiContractErrorResponse(error) ?? projectAssetUsageErrorResponse(error);

async function list(request: Request, context: Context) {
  const { projectId, referenceId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.PROJECT_ASSET_USAGE_READ,
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
  try {
    parsePath(projectAssetReferencePathSchema, { projectId, referenceId });
    const canManage =
      decideAuthorization(guard.actor, PERMISSIONS.PROJECT_ASSET_USAGE_MANAGE, {
        projectId,
        memberRoles: guard.project.memberRoles,
        requireProjectMembership: true
      }).allowed &&
      decideAuthorization(guard.actor, PERMISSIONS.TECHNICAL_ASSET_READ, {
        projectId,
        memberRoles: guard.project.memberRoles,
        requireProjectMembership: true
      }).allowed;
    return Response.json(
      await listProjectAssetUsages({
        projectId,
        referenceId,
        ...parseQuery(request, projectAssetUsageQuerySchema),
        actorId: guard.actor.id,
        auditContext: auditContextFromRequest(request, {
          actorId: guard.actor.id,
          projectId,
          departmentId: guard.project.departmentId,
          reason: "read"
        }),
        canManage
      })
    );
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}

async function create(request: Request, context: Context) {
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
    reason: "project asset usage command failed"
  });
  try {
    const path = parsePath(projectAssetReferencePathSchema, { projectId, referenceId });
    const body = await parseJsonBody(request, projectAssetUsageCreateBodySchema);
    assertIfMatchMatches(parseIfMatchHeader(request), body.referenceVersion, "referenceVersion");
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId,
      departmentId: guard.project.departmentId,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.asset-usage.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createProjectAssetUsage(
          {
            ...path,
            ...body,
            actorId: guard.actor.id,
            auditContext,
            authorizationActor: guard.actor
          },
          transaction
        )
      })
    });
  } catch (error) {
    await recordProjectAssetCommandFailure({
      action: "PROJECT_ASSET_USAGE_CREATED",
      objectType: "PROJECT_ASSET_USAGE",
      objectId: referenceId,
      projectId,
      context: failureAuditContext,
      error
    });
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "assets", operation: "list-project-asset-usages" },
  list
);
export const POST = withRequestObservability(
  { module: "assets", operation: "create-project-asset-usage" },
  create
);
