import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { reviewSatOfflineDraft } from "@/modules/acceptance/application/sat-offline-draft-service";
import {
  acceptanceServiceErrorResponse,
  offlineDraftReviewBodySchema,
  offlineDraftSubmissionPathSchema
} from "@/modules/acceptance/contracts/acceptance-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";

type RouteContext = { params: Promise<{ projectId: string; submissionId: string }> };

async function reviewDraft(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.ACCEPTANCE_REVIEW
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(offlineDraftSubmissionPathSchema, params);
    const body = await parseJsonBody(request, offlineDraftReviewBodySchema);
    if (body.evidenceFileIds.length > 0) {
      const evidenceGuard = await authorizeProjectRequest(
        request,
        path.projectId,
        PERMISSIONS.ACCEPTANCE_EVIDENCE_MANAGE
      );
      if (!evidenceGuard.authorized) return evidenceGuard.response;
    }
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.acceptance.offline-drafts.review",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await reviewSatOfflineDraft(
          {
            ...path,
            ...body,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: body.reason
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      acceptanceServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "acceptance", operation: "review-offline-draft" },
  reviewDraft
);
