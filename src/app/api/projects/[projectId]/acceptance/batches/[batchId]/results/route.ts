import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { recordAcceptanceResultRevision } from "@/modules/acceptance/application/acceptance-service";
import {
  acceptanceBatchPathSchema,
  acceptanceResultBodySchema,
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

async function recordResult(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.ACCEPTANCE_RESULT_UPDATE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(acceptanceBatchPathSchema, params);
    const body = await parseJsonBody(request, acceptanceResultBodySchema);
    if (body.evidenceFileIds.length > 0) {
      const evidenceGuard = await authorizeProjectRequest(
        request,
        path.projectId,
        PERMISSIONS.ACCEPTANCE_EVIDENCE_MANAGE
      );
      if (!evidenceGuard.authorized) return evidenceGuard.response;
    }
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.acceptance.results.record",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await recordAcceptanceResultRevision(
          {
            ...body,
            projectId: path.projectId,
            batchId: path.batchId,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: body.correctionReason ?? "录入验收测试结果"
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
  { module: "acceptance", operation: "record-result" },
  recordResult
);
