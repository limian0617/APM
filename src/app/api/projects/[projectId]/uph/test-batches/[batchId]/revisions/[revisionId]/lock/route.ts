import { z } from "zod";

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
import { lockUphTestBatch } from "@/modules/uph/application/uph-test-batch-service";
import { uphApiErrorResponse } from "@/modules/uph/application/uph-api-errors";
import { lockUphTestBatchBodySchema } from "@/modules/uph/contracts/uph-test-batch-http";

const pathSchema = z.strictObject({
  projectId: z.string().trim().min(1).max(191),
  batchId: z.string().trim().min(1).max(191),
  revisionId: z.string().trim().min(1).max(191)
});
type Context = { params: Promise<{ projectId: string; batchId: string; revisionId: string }> };

async function lock(request: Request, context: Context) {
  try {
    const raw = await context.params;
    const path = parsePath(pathSchema, {
      projectId: raw.projectId,
      batchId: raw.batchId,
      revisionId: raw.revisionId
    });
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS.PROJECT_UPH_BATCH_LOCK,
      { requireProjectMembership: true }
    );
    if (!guard.authorized) return guard.response;
    const body = await parseJsonBody(request, lockUphTestBatchBodySchema);
    assertIfMatchMatches(parseIfMatchHeader(request), body.resourceVersion, "resourceVersion");
    const { idempotencyKey } = parseIdempotencyHeaders(request);
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      projectId: path.projectId,
      departmentId: guard.project.departmentId,
      reason: null
    });
    const serviceInput = {
      ...path,
      actorId: guard.actor.id,
      authorizationActor: guard.actor,
      projectMemberRoles: guard.project.memberRoles,
      resourceVersion: body.resourceVersion,
      body,
      auditContext
    };
    return await idempotentCommandResponse({
      actorId: guard.actor.id,
      operation: "projects.uph.test-batch.lock",
      idempotencyKey,
      request: { path, body },
      execute: async (transaction) => ({
        status: 200,
        body: await lockUphTestBatch(serviceInput, transaction)
      })
    });
  } catch (error) {
    return uphApiErrorResponse(error) ?? Promise.reject(error);
  }
}

export const POST = withRequestObservability({ module: "uph", operation: "lock-test-batch" }, lock);
