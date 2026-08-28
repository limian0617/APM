import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { recordAcceptanceConfirmation } from "@/modules/acceptance/application/acceptance-report-service";
import {
  acceptanceReportPathSchema,
  createAcceptanceConfirmationBodySchema
} from "@/modules/acceptance/contracts/acceptance-report-http";
import { acceptanceServiceErrorResponse } from "@/modules/acceptance/contracts/acceptance-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";

type RouteContext = { params: Promise<{ projectId: string; reportId: string }> };

async function recordConfirmation(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.ACCEPTANCE_REVIEW
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(acceptanceReportPathSchema, params);
    const body = await parseJsonBody(request, createAcceptanceConfirmationBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.acceptance.reports.confirmations.record",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await recordAcceptanceConfirmation(
          {
            ...body,
            projectId: path.projectId,
            reportId: path.reportId,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: "记录客户验收确认"
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
  { module: "acceptance", operation: "record-confirmation" },
  recordConfirmation
);
