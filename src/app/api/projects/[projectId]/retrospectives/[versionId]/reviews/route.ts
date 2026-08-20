import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import {
  ProjectRetrospectiveServiceError,
  reviewRetrospectiveVersion
} from "@/modules/retrospectives/application/project-retrospective-service";
import {
  retrospectiveVersionPathSchema,
  reviewRetrospectiveBodySchema
} from "@/modules/retrospectives/contracts/project-retrospective-http";

type RouteContext = { params: Promise<{ projectId: string; versionId: string }> };
async function post(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_RETROSPECTIVE_REVIEW
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(retrospectiveVersionPathSchema, params);
    const body = await parseJsonBody(request, reviewRetrospectiveBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.retrospectives.review-version",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await reviewRetrospectiveVersion(
          {
            projectId: path.projectId,
            versionId: path.versionId,
            decision: body.decision,
            reason: body.reason,
            expectedAggregateVersion: body.expectedAggregateVersion,
            actorId: guard.actor.id,
            idempotencyKey,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: "审核项目复盘"
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    if (error instanceof ProjectRetrospectiveServiceError)
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    return apiContractErrorResponse(error) ?? Promise.reject(error);
  }
}
export const POST = withRequestObservability(
  { module: "retrospectives", operation: "review" },
  post
);
