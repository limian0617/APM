import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import { parseIdempotencyHeaders, parseJsonBody } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { createProjectBodySchema } from "@/modules/platform-api/contracts/internal-routes";
import { createProjectFromTemplate } from "@/modules/projects/application/create-project";
import { projectCreationErrorResponse } from "@/modules/projects/contracts/project-http";

async function createProject(request: Request) {
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.PROJECT_CREATE,
    AUDIT_OBJECT_TYPES.PROJECT,
    null
  );
  if (!guard.authorized) return guard.response;
  try {
    const body = await parseJsonBody(request, createProjectBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.create-from-template",
      idempotencyKey,
      request: body,
      execute: async (transaction) => ({
        status: 201,
        body: await createProjectFromTemplate(
          {
            ...body,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              reason: body.reason,
              departmentId: body.departmentId
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      projectCreationErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const POST = withRequestObservability(
  { module: "projects", operation: "create-from-template" },
  createProject
);
