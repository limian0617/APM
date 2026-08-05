import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { resubmitGateSubmission } from "@/modules/governance/application/gate-submission-service";
import { gateServiceErrorResponse } from "@/modules/governance/contracts/gate-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  gateSubmissionCommandBodySchema,
  gateSubmissionPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string; submissionId: string }> };

async function resubmit(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(request, params.projectId, PERMISSIONS.GATE_SUBMIT);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(gateSubmissionPathSchema, params);
    const body = await parseJsonBody(request, gateSubmissionCommandBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.gate-submission.resubmit",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await resubmitGateSubmission(
          {
            ...path,
            ...body,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: body.reason
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ?? gateServiceErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "governance", operation: "resubmit-gate-submission" },
  resubmit
);
