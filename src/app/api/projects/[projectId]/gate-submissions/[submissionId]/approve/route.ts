import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  decideGateSubmission,
  findGateSubmissionApproverIds
} from "@/modules/governance/application/gate-submission-service";
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

async function approve(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.GATE_APPROVE,
    async () => ({
      assignedUserIds:
        (await findGateSubmissionApproverIds(params.projectId, params.submissionId)) ?? []
    })
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(gateSubmissionPathSchema, params);
    const body = await parseJsonBody(request, gateSubmissionCommandBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.gate-submission.approve",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await decideGateSubmission(
          {
            ...path,
            ...body,
            decision: "APPROVED",
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
  { module: "governance", operation: "approve-gate-submission" },
  approve
);
