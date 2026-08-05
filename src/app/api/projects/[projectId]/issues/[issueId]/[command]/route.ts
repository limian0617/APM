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
  issueTransitionBodySchema,
  projectIssueCommandPathSchema
} from "@/modules/platform-api/contracts/internal-routes";
import { transitionProjectIssue } from "@/modules/issues/application/issue-service";
import {
  issueServiceErrorResponse,
  parseIssueTransitionPayload
} from "@/modules/issues/contracts/issue-http";

type RouteContext = {
  params: Promise<{ projectId: string; issueId: string; command: string }>;
};

const actionByCommand = {
  "start-analysis": "START_ANALYSIS",
  "start-processing": "START_PROCESSING",
  "submit-verification": "SUBMIT_VERIFICATION",
  "verify-close": "VERIFY_CLOSE",
  reopen: "REOPEN"
} as const;

async function commandIssue(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.PROJECT_ISSUE_UPDATE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectIssueCommandPathSchema, params);
    const body = parseIssueTransitionPayload(
      await parseJsonBody(request, issueTransitionBodySchema)
    );
    if (body.action !== actionByCommand[path.command]) {
      return Response.json(
        { error: { code: "ISSUE_ACTION_PATH_MISMATCH", message: "状态动作与命令路径不一致。" } },
        { status: 422 }
      );
    }
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: `projects.issue.${body.action.toLowerCase()}`,
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await transitionProjectIssue(
          {
            projectId: path.projectId,
            issueId: path.issueId,
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
  { module: "issues", operation: "command-project-issue" },
  commandIssue
);
