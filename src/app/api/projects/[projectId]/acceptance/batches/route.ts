import { PERMISSIONS } from "@/lib/auth/permissions";
import { decideAuthorization } from "@/lib/auth/authorize";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  createAcceptanceBatch,
  listAcceptanceBatches
} from "@/modules/acceptance/application/acceptance-service";
import {
  acceptanceBatchQuerySchema,
  acceptanceServiceErrorResponse,
  createAcceptanceBatchBodySchema
} from "@/modules/acceptance/contracts/acceptance-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { idempotentCommandResponse } from "@/modules/platform-api/application/idempotent-command";
import {
  parseIdempotencyHeaders,
  parseJsonBody,
  parsePath,
  parseQuery
} from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { projectPathSchema } from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ projectId: string }> };

async function readBatches(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.ACCEPTANCE_READ);
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const query = parseQuery(request, acceptanceBatchQuerySchema);
    const context = {
      projectId: path.projectId,
      resourceDepartmentId: guard.project.departmentId,
      memberRoles: guard.project.memberRoles
    };
    const canResult = decideAuthorization(
      guard.actor,
      PERMISSIONS.ACCEPTANCE_RESULT_UPDATE,
      context
    ).allowed;
    const canReview = decideAuthorization(
      guard.actor,
      PERMISSIONS.ACCEPTANCE_REVIEW,
      context
    ).allowed;
    const allowedActions = [
      ...(canResult ? ["CREATE_BATCH", "START_BATCH", "RECORD_RESULT", "REVISE_RESULT"] : []),
      ...(canReview ? ["LOCK_BATCH"] : [])
    ];
    return Response.json(
      await listAcceptanceBatches({ projectId: path.projectId, ...query, allowedActions })
    );
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      acceptanceServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

async function createBatch(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.ACCEPTANCE_RESULT_UPDATE
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const body = await parseJsonBody(request, createAcceptanceBatchBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.acceptance.batches.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createAcceptanceBatch(
          {
            ...body,
            projectId: path.projectId,
            actorId: guard.actor.id,
            auditContext: auditContextFromRequest(request, {
              actorId: guard.actor.id,
              projectId: path.projectId,
              departmentId: guard.project.departmentId,
              reason: "创建验收批次"
            })
          },
          transaction
        )
      })
    });
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      acceptanceServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "acceptance", operation: "list-batches" },
  readBatches
);

export const POST = withRequestObservability(
  { module: "acceptance", operation: "create-batch" },
  createBatch
);
