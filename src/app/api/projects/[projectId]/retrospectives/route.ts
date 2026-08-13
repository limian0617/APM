import { PERMISSIONS } from "@/lib/auth/permissions";
import { decideAuthorization } from "@/lib/auth/authorize";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { projectPathSchema } from "@/modules/platform-api/contracts/internal-routes";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { getProjectRetrospective } from "@/modules/retrospectives/application/project-retrospective-query-service";
import {
  createRetrospectiveVersion,
  ProjectRetrospectiveServiceError
} from "@/modules/retrospectives/application/project-retrospective-service";
import { buildProjectRetrospectivePageState } from "@/modules/retrospectives/contracts/project-retrospective-page-state";
import { createRetrospectiveBodySchema } from "@/modules/retrospectives/contracts/project-retrospective-http";

type RouteContext = { params: Promise<{ projectId: string }> };

function errorResponse(error: unknown): Response | null {
  if (error instanceof ProjectRetrospectiveServiceError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status }
    );
  }
  return apiContractErrorResponse(error);
}

async function read(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_RETROSPECTIVE_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, params);
    const base = await getProjectRetrospective({ projectId: path.projectId });
    const canManage = decideAuthorization(guard.actor, PERMISSIONS.PROJECT_RETROSPECTIVE_MANAGE, {
      projectId: path.projectId,
      memberRoles: guard.project.memberRoles,
      resourceDepartmentId: guard.project.departmentId
    }).allowed;
    const canReview = decideAuthorization(guard.actor, PERMISSIONS.PROJECT_RETROSPECTIVE_REVIEW, {
      projectId: path.projectId,
      memberRoles: guard.project.memberRoles,
      resourceDepartmentId: guard.project.departmentId
    }).allowed;
    const versions = base.versions as Array<{ id: string; status: string }>;
    const latestApproved = versions.find((version) => version.status === "APPROVED") ?? null;
    const state = buildProjectRetrospectivePageState({
      projectId: path.projectId,
      archiveA: (base as any).archiveA ?? null,
      currentVersion: versions[0] ? { id: versions[0].id, status: versions[0].status } : null,
      latestApprovedVersion: latestApproved,
      archiveB: (base as any).archiveB ?? null,
      closurePolicy: (base as any).closurePolicy ?? null,
      canCreate: canManage,
      canSubmit: canManage,
      canReview,
      canGenerateArchiveB: canManage,
      canRunG9: canManage,
      canClose: canManage
    });
    return Response.json({ ...base, ...state });
  } catch (error) {
    return errorResponse(error) ?? Promise.reject(error);
  }
}

async function create(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_RETROSPECTIVE_MANAGE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, params);
    const body = await parseJsonBody(request, createRetrospectiveBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.retrospectives.create-version",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createRetrospectiveVersion(
          {
            projectId: path.projectId,
            retrospectiveInputArchiveVersionId: body.archiveVersionId,
            expectedAggregateVersion: body.expectedAggregateVersion,
            content: body.content,
            contributionInputs: body.contributions,
            participantMembershipIds: body.participantMembershipIds,
            issueHistoryIds: body.issueHistoryIds,
            actorId: guard.actor.id,
            idempotencyKey,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: "创建项目复盘版本"
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    return errorResponse(error) ?? Promise.reject(error);
  }
}

export const GET = withRequestObservability({ module: "retrospectives", operation: "read" }, read);
export const POST = withRequestObservability(
  { module: "retrospectives", operation: "create" },
  create
);
