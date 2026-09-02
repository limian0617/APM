import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  assertIfMatchMatches,
  parseIdempotencyHeaders,
  parseIfMatchHeader,
  parseJsonBody,
  parsePath
} from "@/modules/platform-api/contracts/dto";
import { uphApiErrorResponse } from "@/modules/uph/application/uph-api-errors";
import { createUphRetest, listUphRetests } from "@/modules/uph/application/uph-retest-service";
import {
  createUphRetestBodySchema,
  uphRetestPathSchema
} from "@/modules/uph/contracts/uph-retest-http";

type Context = { params: Promise<{ projectId: string; issueId: string }> };

async function create(request: Request, context: Context) {
  try {
    const path = parsePath(uphRetestPathSchema, await context.params);
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS.PROJECT_UPH_BATCH_MANAGE,
      { requireProjectMembership: true }
    );
    if (!guard.authorized) return guard.response;
    const body = await parseJsonBody(request, createUphRetestBodySchema);
    assertIfMatchMatches(parseIfMatchHeader(request), body.issueVersion, "issueVersion");
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: body.reason
    });
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.issues.uph-retests.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createUphRetest(
          {
            ...path,
            actorId: guard.actor.id,
            authorizationActor: guard.actor,
            projectMemberRoles: guard.project.memberRoles,
            auditContext,
            issueVersion: body.issueVersion,
            reason: body.reason,
            body: {
              batchNumber: body.batchNumber,
              plannedProductionSeconds: body.plannedProductionSeconds,
              planDeclarationReason: body.planDeclarationReason,
              observationStartedAt: body.observationStartedAt,
              observationEndedAt: body.observationEndedAt,
              timezone: body.timezone
            }
          },
          transaction
        )
      })
    });
  } catch (error) {
    return uphApiErrorResponse(error) ?? Promise.reject(error);
  }
}

async function read(request: Request, context: Context) {
  try {
    const path = parsePath(uphRetestPathSchema, await context.params);
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS.PROJECT_ISSUE_READ,
      { requireProjectMembership: true }
    );
    if (!guard.authorized) return guard.response;
    return Response.json(
      await listUphRetests({
        ...path,
        actorId: guard.actor.id,
        authorizationActor: guard.actor,
        projectMemberRoles: guard.project.memberRoles,
        auditContext: auditContextFromRequest(request, {
          actorId: guard.actor.id,
          projectId: path.projectId,
          departmentId: guard.project.departmentId,
          reason: null
        })
      })
    );
  } catch (error) {
    return uphApiErrorResponse(error) ?? Promise.reject(error);
  }
}

export const POST = withRequestObservability({ module: "uph", operation: "create-retest" }, create);
export const GET = withRequestObservability({ module: "uph", operation: "list-retests" }, read);
