import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { lockAcceptanceBatch } from "@/modules/acceptance/application/acceptance-service";
import {
  acceptanceBatchPathSchema,
  acceptanceBatchTransitionBodySchema,
  acceptanceServiceErrorResponse
} from "@/modules/acceptance/contracts/acceptance-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";

type RouteContext = { params: Promise<{ projectId: string; batchId: string }> };

async function lockBatch(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.ACCEPTANCE_REVIEW
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(acceptanceBatchPathSchema, params);
    const body = await parseJsonBody(request, acceptanceBatchTransitionBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.acceptance.batches.lock",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await lockAcceptanceBatch(
          {
            projectId: path.projectId,
            batchId: path.batchId,
            version: body.version,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: body.reason ?? "锁定验收批次"
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      acceptanceServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "acceptance", operation: "lock-batch" },
  lockBatch
);
