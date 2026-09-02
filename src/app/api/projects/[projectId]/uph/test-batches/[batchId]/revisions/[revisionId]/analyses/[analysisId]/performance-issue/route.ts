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
import {
  createUphPerformanceIssue,
  getUphPerformanceIssue
} from "@/modules/uph/application/uph-performance-issue-service";
import { uphApiErrorResponse } from "@/modules/uph/application/uph-api-errors";
import {
  createUphPerformanceIssueBodySchema,
  uphPerformanceIssuePathSchema
} from "@/modules/uph/contracts/uph-performance-issue-http";

type Context = {
  params: Promise<{ projectId: string; batchId: string; revisionId: string; analysisId: string }>;
};

async function create(request: Request, context: Context) {
  try {
    const path = parsePath(uphPerformanceIssuePathSchema, await context.params);
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS.PROJECT_ISSUE_CREATE,
      { requireProjectMembership: true }
    );
    if (!guard.authorized) return guard.response;
    const body = await parseJsonBody(request, createUphPerformanceIssueBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.uph.performance-issue.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => {
        const result = await createUphPerformanceIssue(
          {
            ...path,
            ...body,
            actorId: guard.actor.id,
            authorizationActor: guard.actor,
            projectMemberRoles: guard.project.memberRoles,
            auditContext
          },
          transaction
        );
        return { status: result.deduplicated ? 200 : 201, body: result };
      }
    });
  } catch (error) {
    return uphApiErrorResponse(error) ?? Promise.reject(error);
  }
}

async function read(request: Request, context: Context) {
  try {
    const path = parsePath(uphPerformanceIssuePathSchema, await context.params);
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS.PROJECT_UPH_READ,
      { requireProjectMembership: true }
    );
    if (!guard.authorized) return guard.response;
    return Response.json(
      await getUphPerformanceIssue({
        ...path,
        actorId: guard.actor.id,
        authorizationActor: guard.actor,
        projectMemberRoles: guard.project.memberRoles,
        auditContext: auditContextFromRequest(request, {
          actorId: guard.actor.id,
          projectId: path.projectId,
          departmentId: guard.project.departmentId,
          reason: null
        })
      })
    );
  } catch (error) {
    return uphApiErrorResponse(error) ?? Promise.reject(error);
  }
}

export const POST = withRequestObservability(
  { module: "uph", operation: "create-performance-issue" },
  create
);
export const GET = withRequestObservability(
  { module: "uph", operation: "get-performance-issue" },
  read
);
