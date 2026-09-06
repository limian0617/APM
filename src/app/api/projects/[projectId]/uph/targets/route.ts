import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath,
  parseQuery
} from "@/modules/platform-api/contracts/dto";
import {
  createUphPerformanceTarget,
  listUphPerformanceTargets
} from "@/modules/uph/application/uph-performance-target-service";
import { uphApiErrorResponse } from "@/modules/uph/application/uph-api-errors";
import {
  createUphPerformanceTargetBodySchema,
  listUphPerformanceTargetsQuerySchema,
  uphTargetPathSchema
} from "@/modules/uph/contracts/uph-performance-target-http";

type Context = { params: Promise<{ projectId: string }> };

async function read(request: Request, context: Context) {
  try {
    const raw = await context.params;
    const path = parsePath(uphTargetPathSchema, raw);
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS.PROJECT_UPH_READ,
      {
        requireProjectMembership: true
      }
    );
    if (!guard.authorized) return guard.response;
    const query = parseQuery(request, listUphPerformanceTargetsQuerySchema);
    return Response.json(
      await listUphPerformanceTargets({
        projectId: path.projectId,
        ...(query.topologyRootNodeId ? { topologyRootNodeId: query.topologyRootNodeId } : {}),
        ...(query.revisionId ? { revisionId: query.revisionId } : {}),
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

async function create(request: Request, context: Context) {
  try {
    const raw = await context.params;
    const path = parsePath(uphTargetPathSchema, raw);
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS.PROJECT_UPH_DEFINITION_MANAGE,
      { requireProjectMembership: true }
    );
    if (!guard.authorized) return guard.response;
    const body = await parseJsonBody(request, createUphPerformanceTargetBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.uph.performance-target.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createUphPerformanceTarget(
          {
            projectId: path.projectId,
            actorId: guard.actor.id,
            authorizationActor: guard.actor,
            projectMemberRoles: guard.project.memberRoles,
            topologyRootNodeId: body.topologyRootNodeId,
            targetUph: body.targetUph,
            reason: body.reason,
            auditContext
          },
          transaction
        )
      })
    });
  } catch (error) {
    return uphApiErrorResponse(error) ?? Promise.reject(error);
  }
}

export const GET = withRequestObservability(
  { module: "uph", operation: "list-performance-targets" },
  read
);
export const POST = withRequestObservability(
  { module: "uph", operation: "create-performance-target" },
  create
);
