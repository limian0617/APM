import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  confirmProjectCapabilities,
  readProjectCapabilities
} from "@/modules/configuration/application/project-capability-service";
import { projectCapabilityErrorResponse } from "@/modules/configuration/contracts/project-capability-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  confirmProjectCapabilitiesBodySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };

async function readCapabilities(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;

  try {
    const path = parsePath(projectPathSchema, { projectId });
    return Response.json(await readProjectCapabilities(path.projectId));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      projectCapabilityErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

async function confirmCapabilities(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_PLAN_UPDATE);
  if (!guard.authorized) return guard.response;

  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, confirmProjectCapabilitiesBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.capabilities.confirm",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await confirmProjectCapabilities(
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
      projectCapabilityErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "configuration", operation: "read-project-capabilities" },
  readCapabilities
);
export const POST = withRequestObservability(
  { module: "configuration", operation: "confirm-project-capabilities" },
  confirmCapabilities
);
