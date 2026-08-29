import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  createIssueFromAcceptanceFailure,
  listIssuesForAcceptanceFailure
} from "@/modules/acceptance/application/acceptance-issue-service";
import {
  acceptanceFailureIssueCreateBodySchema,
  acceptanceFailurePathSchema,
  acceptanceServiceErrorResponse
} from "@/modules/acceptance/contracts/acceptance-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { issueServiceErrorResponse } from "@/modules/issues/contracts/issue-http";
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

async function listFailureIssues(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_ISSUE_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(acceptanceFailurePathSchema, params);
    return Response.json(await listIssuesForAcceptanceFailure(path));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      acceptanceServiceErrorResponse(error) ??
      issueServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

async function createFailureIssue(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_ISSUE_CREATE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(acceptanceFailurePathSchema, params);
    const body = await parseJsonBody(request, acceptanceFailureIssueCreateBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.acceptance.failure-issues.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createIssueFromAcceptanceFailure({
          ...path,
          ...body,
          actorId: guard.actor.id,
          auditContext: auditContextFromRequest(request, {
            actorId: guard.actor.id,
            projectId: path.projectId,
            departmentId: guard.project.departmentId,
            reason: "从 FAT/SAT FAIL 结果创建统一问题"
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

export const GET = withRequestObservability(
  { module: "acceptance", operation: "list-failure-issues" },
  listFailureIssues
);
export const POST = withRequestObservability(
  { module: "acceptance", operation: "create-failure-issue" },
  createFailureIssue
);
