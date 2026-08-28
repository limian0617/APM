import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  projectCalendarCloseBodySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";
import { closeProjectCalendar } from "@/modules/planning/application/schedule-network-service";
import { planningErrorResponse } from "@/modules/planning/contracts/planning-http";

type RouteContext = { params: Promise<{ projectId: string }> };

async function closeCalendar(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_PLAN_UPDATE);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, projectCalendarCloseBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "planning.project-calendar.close",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await closeProjectCalendar(
          {
            projectId: path.projectId,
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
    return apiContractErrorResponse(error) ?? planningErrorResponse(error) ?? Promise.reject(error);
  }
}

export const POST = withRequestObservability(
  { module: "planning", operation: "close-project-calendar" },
  closeCalendar
);
