import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { requestProjectAlertScan } from "@/modules/governance/application/alert-service";
import { alertServiceErrorResponse } from "@/modules/governance/contracts/alert-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import { parseIdempotencyHeaders, parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { projectPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };

async function requestScan(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_ALERT_MANAGE);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.alert-scan.request",
      idempotencyKey,
      request: { path },
      execute: async (transaction) => ({
        status: 202,
        body: await requestProjectAlertScan(
          {
            projectId: path.projectId,
            idempotencyKey,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: "请求项目预警扫描"
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ?? alertServiceErrorResponse(error) ?? Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "governance", operation: "request-alert-scan" },
  requestScan
);
