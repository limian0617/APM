import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { closeProjectIssueRelation } from "@/modules/issues/application/issue-service";
import {
  issueServiceErrorResponse,
  parseIssueRelationClosePayload
} from "@/modules/issues/contracts/issue-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  issueRelationCloseBodySchema,
  projectIssueRelationPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = {
  params: Promise<{ projectId: string; issueId: string; relationId: string }>;
};

async function closeIssueRelation(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_ISSUE_UPDATE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectIssueRelationPathSchema, params);
    const body = parseIssueRelationClosePayload(
      await parseJsonBody(request, issueRelationCloseBodySchema)
    );
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.issue.close-relation",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await closeProjectIssueRelation(
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
      apiContractErrorResponse(error) ?? issueServiceErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "issues", operation: "close-project-issue-relation" },
  closeIssueRelation
);
