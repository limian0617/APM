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
  responsibilityPackagePathSchema,
  updateResponsibilityPackageBodySchema
} from "@/modules/platform-api/contracts/internal-routes";
import {
  getResponsibilityPackage,
  updateResponsibilityPackage
} from "@/modules/projects/application/responsibility-package-service";
import { responsibilityPackageErrorResponse } from "@/modules/projects/contracts/project-http";

type RouteContext = { params: Promise<{ projectId: string; packageId: string }> };

async function readPackage(request: Request, context: RouteContext) {
  const { projectId, packageId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(responsibilityPackagePathSchema, { projectId, packageId });
    return Response.json(await getResponsibilityPackage(path.projectId, path.packageId));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      responsibilityPackageErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

async function updatePackage(request: Request, context: RouteContext) {
  const { projectId, packageId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_PLAN_UPDATE);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(responsibilityPackagePathSchema, { projectId, packageId });
    const body = await parseJsonBody(request, updateResponsibilityPackageBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.responsibility-package.update",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await updateResponsibilityPackage(
          {
            projectId: path.projectId,
            packageId: path.packageId,
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
      responsibilityPackageErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "projects", operation: "read-responsibility-package" },
  readPackage
);
export const PUT = withRequestObservability(
  { module: "projects", operation: "update-responsibility-package" },
  updatePackage
);
