import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  addProjectIssueRelation,
  getProjectIssue
} from "@/modules/issues/application/issue-service";
import {
  issueServiceErrorResponse,
  parseIssueRelationPayload
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
  issueRelationBodySchema,
  projectIssuePathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string; issueId: string }> };

async function listIssueRelations(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_ISSUE_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectIssuePathSchema, params);
    const { issue } = await getProjectIssue(path.projectId, path.issueId);
    return Response.json({ relations: issue.relations, resourceVersion: issue.version });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ?? issueServiceErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

async function addIssueRelation(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_ISSUE_UPDATE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectIssuePathSchema, params);
    const body = parseIssueRelationPayload(await parseJsonBody(request, issueRelationBodySchema));
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.issue.add-relation",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await addProjectIssueRelation(
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

export const GET = withRequestObservability(
  { module: "issues", operation: "list-project-issue-relations" },
  listIssueRelations
);
export const POST = withRequestObservability(
  { module: "issues", operation: "add-project-issue-relation" },
  addIssueRelation
);
