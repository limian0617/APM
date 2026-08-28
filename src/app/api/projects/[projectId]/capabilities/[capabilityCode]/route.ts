import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { updateProjectCapability } from "@/modules/configuration/application/project-capability-service";
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
  projectCapabilityBodySchema,
  projectCapabilityPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = {
  params: Promise<{ projectId: string; capabilityCode: string }>;
};

async function changeCapability(request: Request, context: RouteContext) {
  const { projectId, capabilityCode } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_PLAN_UPDATE);
  if (!guard.authorized) return guard.response;

  try {
    const path = parsePath(projectCapabilityPathSchema, { projectId, capabilityCode });
    const body = await parseJsonBody(request, projectCapabilityBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.capability.update",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await updateProjectCapability(
          {
            projectId: path.projectId,
            capabilityCode: path.capabilityCode,
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

export const PUT = withRequestObservability(
  { module: "configuration", operation: "update-project-capability" },
  changeCapability
);
