import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  assertIfMatchMatches,
  parseIdempotencyHeaders,
  parseIfMatchHeader,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { publishUphPerformanceTarget } from "@/modules/uph/application/uph-performance-target-service";
import { uphApiErrorResponse } from "@/modules/uph/application/uph-api-errors";
import {
  publishUphPerformanceTargetBodySchema,
  uphTargetVersionPathSchema
} from "@/modules/uph/contracts/uph-performance-target-http";

type Context = { params: Promise<{ projectId: string; targetVersionId: string }> };

async function publish(request: Request, context: Context) {
  try {
    const raw = await context.params;
    const path = parsePath(uphTargetVersionPathSchema, raw);
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS.PROJECT_UPH_PUBLISH,
      {
        requireProjectMembership: true
      }
    );
    if (!guard.authorized) return guard.response;
    const body = await parseJsonBody(request, publishUphPerformanceTargetBodySchema);
    assertIfMatchMatches(parseIfMatchHeader(request), body.resourceVersion, "resourceVersion");
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.uph.performance-target.publish",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await publishUphPerformanceTarget(
          {
            projectId: path.projectId,
            targetVersionId: path.targetVersionId,
            actorId: guard.actor.id,
            authorizationActor: guard.actor,
            projectMemberRoles: guard.project.memberRoles,
            resourceVersion: body.resourceVersion,
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

export const POST = withRequestObservability(
  { module: "uph", operation: "publish-performance-target" },
  publish
);
