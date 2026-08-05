import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { refreshProjectResourceLoad } from "@/modules/cockpit/application/resource-load-projection-service";
import { resourceLoadProjectionErrorResponse } from "@/modules/cockpit/contracts/resource-load-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  projectPathSchema,
  resourceLoadRefreshBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };

async function refreshResourceLoad(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_PLAN_UPDATE);
  if (!guard.authorized) return guard.response;

  try {
    const path = parsePath(projectPathSchema, { projectId });
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const body = await parseJsonBody(request, resourceLoadRefreshBodySchema);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.cockpit.resource-load.refresh",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => {
        const result = await refreshProjectResourceLoad(
          {
            projectId: path.projectId,
            reason: body.reason,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: body.reason
            })
          },
          transaction
        );
        return {
          status: 200,
          body: {
            status: "READY",
            projection: result.projection,
            resourceVersion: result.projection.sourceChecksum,
            auditId: result.auditId
          }
        };
      }
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      resourceLoadProjectionErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "cockpit", operation: "refresh-resource-load" },
  refreshResourceLoad
);
