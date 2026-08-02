import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { replayDeadLetterJob, ReplayJobError } from "@/modules/governance/application/replay-job";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import {
  apiContractErrorResponse,
  apiErrorResponse
} from "@/modules/platform-api/contracts/errors";
import {
  jobPathSchema,
  replayJobBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ jobId: string }> };

async function replayJob(request: Request, context: RouteContext) {
  const { jobId } = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.JOB_REPLAY,
    AUDIT_OBJECT_TYPES.PERSISTENT_JOB,
    jobId
  );
  if (!guard.authorized) {
    return guard.response;
  }

  try {
    const path = parsePath(jobPathSchema, { jobId });
    const input = await parseJsonBody(request, replayJobBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      reason: input.reason
    });
    return idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "governance.job.replay",
      idempotencyKey,
      request: { path, body: input },
      execute: async (transaction) => ({
        status: 202,
        body: await replayDeadLetterJob(
          {
            jobId: path.jobId,
            actor: guard.actor,
            reason: input.reason,
            auditContext
          },
          transaction
        )
      })
    });
  } catch (error) {
    const contractResponse = apiContractErrorResponse(error);
    if (contractResponse) return contractResponse;
    if (error instanceof ReplayJobError) {
      return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
    }
    throw error;
  }
}

export const POST = withRequestObservability({ module: "jobs", operation: "replay" }, replayJob);
