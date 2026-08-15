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
import {
  getProjectRetrospective,
  ProjectRetrospectiveQueryError
} from "@/modules/retrospectives/application/project-retrospective-query-service";
import {
  createRetrospectiveVersion,
  ProjectRetrospectiveServiceError
} from "@/modules/retrospectives/application/project-retrospective-service";
import { findGateSubmissionApproverIds } from "@/modules/governance/application/gate-submission-service";
import { buildProjectRetrospectivePageState } from "@/modules/retrospectives/contracts/project-retrospective-page-state";
import { createRetrospectiveBodySchema } from "@/modules/retrospectives/contracts/project-retrospective-http";

type RouteContext = { params: Promise<{ projectId: string }> };

function errorResponse(error: unknown): Response | null {
  if (
    typeof ProjectRetrospectiveServiceError === "function" &&
    error instanceof ProjectRetrospectiveServiceError
  ) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status }
    );
  }
  if (
    (typeof ProjectRetrospectiveQueryError === "function" &&
      error instanceof ProjectRetrospectiveQueryError) ||
    (error &&
      typeof error === "object" &&
      ((error as { code?: unknown }).code === "PROJECT_RETROSPECTIVE_POINTER_INVALID" ||
        (error as { message?: unknown }).message === "PROJECT_RETROSPECTIVE_POINTER_INVALID"))
  ) {
    const queryError = error as { code?: unknown; message?: unknown };
    return Response.json(
      {
        error: {
          code: queryError.code ?? "PROJECT_RETROSPECTIVE_POINTER_INVALID",
          message: queryError.message ?? "项目复盘冻结指针无效。"
        }
      },
      { status: 409 }
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
    const canGateSubmit = decideAuthorization(guard.actor, PERMISSIONS.GATE_SUBMIT, {
      projectId: path.projectId,
      memberRoles: guard.project.memberRoles,
      resourceDepartmentId: guard.project.departmentId
    }).allowed;
    const approverIds = base.g9Workflow?.submission
      ? await findGateSubmissionApproverIds(path.projectId, base.g9Workflow.submission.id)
      : [];
    const canGateApprove = decideAuthorization(guard.actor, PERMISSIONS.GATE_APPROVE, {
      projectId: path.projectId,
      memberRoles: guard.project.memberRoles,
      resourceDepartmentId: guard.project.departmentId,
      assignedUserIds: approverIds ?? []
    }).allowed;
    const g9Workflow = base.g9Workflow
      ? {
          ...base.g9Workflow,
          canRunChecks: canGateSubmit && base.g9Workflow.submission === null,
          canSubmit:
            canGateSubmit &&
            base.g9Workflow.latestCheckStatus === "PASSED" &&
            base.g9Workflow.submission === null,
          canApprove: canGateApprove && base.g9Workflow.submission?.status === "PENDING"
        }
      : null;
    const state = buildProjectRetrospectivePageState({
      projectId: path.projectId,
      projectStatus: guard.project.status,
      projectVersion: guard.project.version,
      archiveA: base.archiveA ?? null,
      currentVersion: base.currentVersion
        ? { id: base.currentVersion.id, status: base.currentVersion.status }
        : null,
      latestApprovedVersion: base.latestApprovedVersion
        ? { id: base.latestApprovedVersion.id, status: base.latestApprovedVersion.status }
        : null,
      archiveB: base.archiveB ?? null,
      closurePolicy: base.closurePolicy ?? null,
      g9Approval: base.g9Approval ?? null,
      canCreate: canManage,
      canSubmit: canManage,
      canReview,
      canGenerateArchiveB: canGateSubmit,
      canRunG9: canGateSubmit,
      canClose: canGateApprove
    });
    return Response.json({
      ...base,
      aggregateVersion: base.retrospective?.version ?? null,
      g9Workflow,
      ...state
    });
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
