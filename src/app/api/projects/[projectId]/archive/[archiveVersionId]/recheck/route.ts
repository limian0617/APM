import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import {
  archiveServiceErrorResponse,
  requestArchiveIntegrityRecheck
} from "@/modules/archives/application/archive-service";
import {
  archiveRecheckBodySchema,
  archiveVersionPathSchema
} from "@/modules/archives/contracts/archive-http";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";

type RouteContext = { params: Promise<{ projectId: string; archiveVersionId: string }> };
async function recheck(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(request, params.projectId, PERMISSIONS.GATE_SUBMIT);
  if (!guard.authorized) return guard.response;
  const path = parsePath(archiveVersionPathSchema, params);
  const body = await parseJsonBody(request, archiveRecheckBodySchema);
  const { idempotencyKey } = parseIdempotencyHeaders(request);
  try {
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.archive.recheck",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 202,
        body: await requestArchiveIntegrityRecheck(
          {
            projectId: path.projectId,
            archiveVersionId: path.archiveVersionId,
            version: body.version,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: "请求归档完整性复核"
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ?? archiveServiceErrorResponse(error) ?? Promise.reject(error)
    );
  }
}
export const POST = withRequestObservability({ module: "archives", operation: "recheck" }, recheck);
