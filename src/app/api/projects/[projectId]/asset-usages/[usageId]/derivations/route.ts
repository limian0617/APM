import { decideAuthorization } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  createProjectAssetDerivation,
  listProjectAssetDerivations,
  recordProjectAssetCommandFailure
} from "@/modules/assets/application/project-asset-usage-service";
import {
  projectAssetDerivationCreateBodySchema,
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
const errors = (error: unknown) =>
  apiContractErrorResponse(error) ?? projectAssetUsageErrorResponse(error);

async function list(request: Request, context: Context) {
  const { projectId, usageId } = await context.params;
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
    parsePath(projectAssetUsagePathSchema, { projectId, usageId });
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
      await listProjectAssetDerivations({
        projectId,
        usageId,
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
    const response = errors(error);
    if (response) return response;
    throw error;
  }
}

async function create(request: Request, context: Context) {
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
  const documentReadGuard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.CONTROLLED_DOCUMENT_READ,
    { requireProjectMembership: true }
  );
  if (!documentReadGuard.authorized) return documentReadGuard.response;
  const failureAuditContext = auditContextFromRequest(request, {
    actorId: guard.actor.id,
    projectId,
    departmentId: guard.project.departmentId,
    reason: "project asset derivation command failed"
  });
  try {
    const path = parsePath(projectAssetUsagePathSchema, { projectId, usageId });
    const body = await parseJsonBody(request, projectAssetDerivationCreateBodySchema);
    assertIfMatchMatches(parseIfMatchHeader(request), body.usageVersion, "usageVersion");
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId,
      departmentId: guard.project.departmentId,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.asset-derivation.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createProjectAssetDerivation(
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
      action: "PROJECT_ASSET_DERIVATION_CREATED",
      objectType: "PROJECT_ASSET_DERIVATION",
      objectId: usageId,
      projectId,
      context: failureAuditContext,
      error
    });
    const response = errors(error);
    if (response) return response;
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "assets", operation: "list-project-asset-derivations" },
  list
);
export const POST = withRequestObservability(
  { module: "assets", operation: "create-project-asset-derivation" },
  create
);
