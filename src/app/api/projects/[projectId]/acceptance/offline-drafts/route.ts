import { PERMISSIONS } from "@/lib/auth/permissions";
import { decideAuthorization } from "@/lib/auth/authorize";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  listSatOfflineDrafts,
  submitSatOfflineDraft
} from "@/modules/acceptance/application/sat-offline-draft-service";
import {
  acceptanceServiceErrorResponse,
  offlineDraftQuerySchema,
  offlineDraftSubmissionBodySchema
} from "@/modules/acceptance/contracts/acceptance-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath,
  parseQuery
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { projectPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };

async function readDrafts(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.ACCEPTANCE_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const query = parseQuery(request, offlineDraftQuerySchema);
    const canReview = decideAuthorization(guard.actor, PERMISSIONS.ACCEPTANCE_REVIEW, {
      projectId: path.projectId,
      resourceDepartmentId: guard.project.departmentId,
      memberRoles: guard.project.memberRoles
    }).allowed;
    return Response.json(
      await listSatOfflineDrafts({
        projectId: path.projectId,
        ...query,
        allowedActions: canReview ? ["REVIEW_OFFLINE_DRAFT"] : []
      })
    );
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      acceptanceServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

async function submitDraft(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.ACCEPTANCE_RESULT_UPDATE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, offlineDraftSubmissionBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.acceptance.offline-drafts.submit",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => {
        const result = await submitSatOfflineDraft(
          {
            ...body,
            projectId: path.projectId,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: "提交 SAT 离线草稿"
            })
          },
          transaction
        );
        return { status: result.idempotent ? 200 : 202, body: result };
      }
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      acceptanceServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "acceptance", operation: "list-offline-drafts" },
  readDrafts
);
export const POST = withRequestObservability(
  { module: "acceptance", operation: "submit-offline-draft" },
  submitDraft
);
