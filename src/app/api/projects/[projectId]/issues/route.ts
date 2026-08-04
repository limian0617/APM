import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  createProjectIssueBodySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";
import { createProjectIssue, listProjectIssues } from "@/modules/issues/application/issue-service";
import {
  issueServiceErrorResponse,
  parseIssueCreatePayload,
  parseIssueListQuery
} from "@/modules/issues/contracts/issue-http";

type RouteContext = { params: Promise<{ projectId: string }> };

async function listIssues(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_ISSUE_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const query = parseIssueListQuery(new URL(request.url));
    return Response.json(await listProjectIssues({ projectId: path.projectId, ...query }));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ?? issueServiceErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

async function createIssue(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_ISSUE_CREATE);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = parseIssueCreatePayload(
      await parseJsonBody(request, createProjectIssueBodySchema)
    );
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.issue.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createProjectIssue(
          {
            projectId: path.projectId,
            ...body,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId
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
  { module: "issues", operation: "list-project-issues" },
  listIssues
);
export const POST = withRequestObservability(
  { module: "issues", operation: "create-project-issue" },
  createIssue
);
