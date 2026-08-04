import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { refreshProjectCockpitProjection } from "@/modules/cockpit/application/cockpit-projection-service";
import { cockpitProjectionErrorResponse } from "@/modules/cockpit/contracts/cockpit-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  cockpitRefreshBodySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };

async function refreshCockpit(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_PLAN_UPDATE);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const body = await parseJsonBody(request, cockpitRefreshBodySchema);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.cockpit.refresh",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => {
        const result = await refreshProjectCockpitProjection(
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
      cockpitProjectionErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "cockpit", operation: "refresh-cockpit" },
  refreshCockpit
);
