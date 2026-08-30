import { z } from "zod";

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
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import {
  createUphTestBatch,
  listUphTestBatches
} from "@/modules/uph/application/uph-test-batch-service";
import { uphApiErrorResponse } from "@/modules/uph/application/uph-api-errors";
import {
  createUphTestBatchBodySchema,
  listUphTestBatchesQuerySchema
} from "@/modules/uph/contracts/uph-test-batch-http";

const pathSchema = z.strictObject({ projectId: z.string().trim().min(1).max(191) });
type Context = { params: Promise<{ projectId: string }> };

async function create(request: Request, context: Context) {
  try {
    const raw = await context.params;
    const path = parsePath(pathSchema, { projectId: raw.projectId });
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS.PROJECT_UPH_BATCH_MANAGE,
      { requireProjectMembership: true }
    );
    if (!guard.authorized) return guard.response;
    const body = await parseJsonBody(request, createUphTestBatchBodySchema);
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: null
    });
    const serviceInput = {
      projectId: path.projectId,
      actorId: guard.actor.id,
      authorizationActor: guard.actor,
      projectMemberRoles: guard.project.memberRoles,
      body,
      auditContext
    };
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.uph.test-batch.create",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 201,
        body: await createUphTestBatch(serviceInput, transaction)
      })
    });
  } catch (error) {
    return uphApiErrorResponse(error) ?? Promise.reject(error);
  }
}

async function list(request: Request, context: Context) {
  try {
    const raw = await context.params;
    const path = parsePath(pathSchema, { projectId: raw.projectId });
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS.PROJECT_UPH_READ,
      {
        requireProjectMembership: true
      }
    );
    if (!guard.authorized) return guard.response;
    let query;
    try {
      query = parseQuery(request, listUphTestBatchesQuerySchema);
    } catch (error) {
      if (error instanceof ApiContractError) {
        throw new ApiContractError(error.code, error.message, 422, error.issues);
      }
      throw error;
    }
    return Response.json(
      await listUphTestBatches({
        projectId: path.projectId,
        authorizationActor: guard.actor,
        projectMemberRoles: guard.project.memberRoles,
        ...query
      })
    );
  } catch (error) {
    return uphApiErrorResponse(error) ?? Promise.reject(error);
  }
}

export const POST = withRequestObservability(
  { module: "uph", operation: "create-test-batch" },
  create
);
export const GET = withRequestObservability(
  { module: "uph", operation: "list-test-batches" },
  list
);
