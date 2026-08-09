import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { linkExistingIssueToAcceptanceFailure } from "@/modules/acceptance/application/acceptance-issue-service";
import {
  acceptanceFailureIssueLinkBodySchema,
  acceptanceFailurePathSchema,
  acceptanceServiceErrorResponse
} from "@/modules/acceptance/contracts/acceptance-http";
import { issueServiceErrorResponse } from "@/modules/issues/contracts/issue-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";

type RouteContext = {
  params: Promise<{ projectId: string; batchId: string; resultRevisionId: string }>;
};

async function linkFailureIssue(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_ISSUE_UPDATE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(acceptanceFailurePathSchema, params);
    const body = await parseJsonBody(request, acceptanceFailureIssueLinkBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.acceptance.failure-issues.link",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await linkExistingIssueToAcceptanceFailure({
          ...path,
          ...body,
          actorId: guard.actor.id,
          auditContext: auditContextFromRequest(request, {
            actorId: guard.actor.id,
            projectId: path.projectId,
            departmentId: guard.project.departmentId,
            reason: body.reason
          }),
          transaction
        })
      })
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      acceptanceServiceErrorResponse(error) ??
      issueServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "acceptance", operation: "link-failure-issue" },
  linkFailureIssue
);
