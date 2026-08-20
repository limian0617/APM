import { PERMISSIONS } from "@/lib/auth/permissions";
import { decideAuthorization } from "@/lib/auth/authorize";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  createProjectAssetReference,
  listProjectAssetReferences,
  recordProjectAssetCommandFailure
} from "@/modules/assets/application/project-asset-usage-service";
import { projectAssetUsageErrorResponse } from "@/modules/assets/contracts/project-asset-usage-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  createProjectAssetReferenceBodySchema,
  projectAssetReferenceQuerySchema,
  projectPathSchema
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

type Context = { params: Promise<{ projectId: string }> };
const errorResponse = (error: unknown) =>
  apiContractErrorResponse(error) ?? projectAssetUsageErrorResponse(error);

async function list(request: Request, context: Context) {
  const { projectId } = await context.params;
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
    const path = parsePath(projectPathSchema, { projectId });
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
      await listProjectAssetReferences({
        projectId: path.projectId,
        ...parseQuery(request, projectAssetReferenceQuerySchema),
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
  const { projectId } = await context.params;
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
    reason: "project asset reference command failed"
  });
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, createProjectAssetReferenceBodySchema);
    const ifMatch = parseIfMatchHeader(request);
    assertIfMatchMatches(ifMatch, body.projectVersion, "projectVersion");
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.asset-reference.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createProjectAssetReference(
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
      action: "PROJECT_ASSET_REFERENCE_CREATED",
      objectType: "PROJECT_ASSET_REFERENCE",
      objectId: projectId,
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
  { module: "assets", operation: "list-project-asset-references" },
  list
);
export const POST = withRequestObservability(
  { module: "assets", operation: "create-project-asset-reference" },
  create
);
