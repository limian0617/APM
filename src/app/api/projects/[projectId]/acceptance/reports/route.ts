import { decideAuthorization } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  generateAcceptanceReport,
  listAcceptanceReports
} from "@/modules/acceptance/application/acceptance-report-service";
import { generateAcceptanceReportBodySchema } from "@/modules/acceptance/contracts/acceptance-report-http";
import { acceptanceServiceErrorResponse } from "@/modules/acceptance/contracts/acceptance-http";
import { createS3ObjectStorageFromEnvironment } from "@/modules/documents/infrastructure/s3-object-storage";
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

async function getReports(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.ACCEPTANCE_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const authorizationContext = {
      projectId: path.projectId,
      resourceDepartmentId: guard.project.departmentId,
      memberRoles: guard.project.memberRoles
    };
    const allowedActions = [
      ...(decideAuthorization(guard.actor, PERMISSIONS.ACCEPTANCE_REVIEW, authorizationContext)
        .allowed
        ? ["GENERATE_REPORT", "RECORD_CONFIRMATION"]
        : []),
      ...(decideAuthorization(
        guard.actor,
        PERMISSIONS.SENSITIVE_CONFIRMATION_READ,
        authorizationContext
      ).allowed
        ? ["VIEW_SENSITIVE_CONFIRMATION"]
        : [])
    ];
    return Response.json({
      ...(await listAcceptanceReports({ projectId: path.projectId })),
      allowedActions
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      acceptanceServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

async function generateReport(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.ACCEPTANCE_REVIEW);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, generateAcceptanceReportBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.acceptance.reports.generate",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await generateAcceptanceReport(
          {
            ...body,
            projectId: path.projectId,
            actorId: guard.actor.id,
            storage: createS3ObjectStorageFromEnvironment(),
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: "生成受控 FAT/SAT 验收报告"
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

export const GET = withRequestObservability(
  { module: "acceptance", operation: "list-reports" },
  getReports
);
export const POST = withRequestObservability(
  { module: "acceptance", operation: "generate-report" },
  generateReport
);
