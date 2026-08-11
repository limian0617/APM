import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import {
  archiveServiceErrorResponse,
  requestArchiveGeneration
} from "@/modules/archives/application/archive-service";
import { archiveGenerationBodySchema } from "@/modules/archives/contracts/archive-http";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { projectPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };
async function generate(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.GATE_SUBMIT);
  if (!guard.authorized) return guard.response;
  const path = parsePath(projectPathSchema, { projectId });
  const body = await parseJsonBody(request, archiveGenerationBodySchema);
  const { idempotencyKey } = parseIdempotencyHeaders(request);
  try {
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.archive.generate",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 202,
        body: await requestArchiveGeneration(
          {
            projectId: path.projectId,
            version: body.version,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: "请求生成结项归档"
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
export const POST = withRequestObservability(
  { module: "archives", operation: "generate" },
  generate
);
