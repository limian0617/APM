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
  procurementSettingsBodySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";
import { configureProjectProcurement } from "@/modules/procurement/application/procurement-settings-service";
import { readProjectProcurementSettings } from "@/modules/procurement/infrastructure/prisma-procurement-source";
import { procurementServiceErrorResponse } from "@/modules/procurement/contracts/procurement-http";

type RouteContext = { params: Promise<{ projectId: string }> };

async function getSettings(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    return Response.json({ settings: await readProjectProcurementSettings(path.projectId) });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      procurementServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

async function putSettings(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_POLICY_MANAGE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, procurementSettingsBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.procurement.settings.configure",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await configureProjectProcurement(
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
    return (
      apiContractErrorResponse(error) ??
      procurementServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "procurement", operation: "read-settings" },
  getSettings
);
export const PUT = withRequestObservability(
  { module: "procurement", operation: "configure-settings" },
  putSettings
);
