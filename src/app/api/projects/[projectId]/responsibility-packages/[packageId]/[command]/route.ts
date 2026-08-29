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
  responsibilityPackageCommandBodySchema,
  responsibilityPackageCommandPathSchema
} from "@/modules/platform-api/contracts/internal-routes";
import {
  responsibilityPackageOwnerUserId,
  transitionResponsibilityPackage
} from "@/modules/projects/application/responsibility-package-service";
import { responsibilityPackageErrorResponse } from "@/modules/projects/contracts/project-http";
import type { ResponsibilityPackageTransitionCode } from "@/modules/projects/domain/responsibility-package";

type RouteContext = {
  params: Promise<{ projectId: string; packageId: string; command: string }>;
};

const transitionByCommand = {
  submit: "ACCEPTANCE_SUBMITTED",
  accept: "ACCEPTED",
  reopen: "REOPENED",
  close: "CLOSED"
} as const satisfies Record<string, ResponsibilityPackageTransitionCode>;

async function commandPackage(request: Request, context: RouteContext) {
  const params = await context.params;
  try {
    const path = parsePath(responsibilityPackageCommandPathSchema, params);
    const ownerUserId =
      path.command === "submit"
        ? await responsibilityPackageOwnerUserId(path.projectId, path.packageId)
        : null;
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      path.command === "submit"
        ? PERMISSIONS.TASK_PROGRESS_UPDATE
        : PERMISSIONS.PROJECT_PLAN_UPDATE,
      path.command === "submit" ? { resourceOwnerId: ownerUserId } : {}
    );
    if (!guard.authorized) return guard.response;
    const body = await parseJsonBody(request, responsibilityPackageCommandBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: `projects.responsibility-package.${path.command}`,
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await transitionResponsibilityPackage(
          {
            projectId: path.projectId,
            packageId: path.packageId,
            transition: transitionByCommand[path.command],
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

export const POST = withRequestObservability(
  { module: "projects", operation: "command-responsibility-package" },
  commandPackage
);
