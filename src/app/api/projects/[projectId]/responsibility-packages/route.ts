import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath,
  parseQuery
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  createResponsibilityPackageBodySchema,
  projectPathSchema,
  responsibilityPackageQuerySchema
} from "@/modules/platform-api/contracts/internal-routes";
import {
  createResponsibilityPackage,
  listResponsibilityPackages
} from "@/modules/projects/application/responsibility-package-service";
import { responsibilityPackageErrorResponse } from "@/modules/projects/contracts/project-http";

type RouteContext = { params: Promise<{ projectId: string }> };

async function listPackages(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const query = parseQuery(request, responsibilityPackageQuerySchema);
    return Response.json(await listResponsibilityPackages({ projectId: path.projectId, ...query }));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      responsibilityPackageErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

async function createPackage(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.PROJECT_PLAN_UPDATE);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, createResponsibilityPackageBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.responsibility-package.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createResponsibilityPackage(
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
      responsibilityPackageErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "projects", operation: "list-responsibility-packages" },
  listPackages
);
export const POST = withRequestObservability(
  { module: "projects", operation: "create-responsibility-package" },
  createPackage
);
