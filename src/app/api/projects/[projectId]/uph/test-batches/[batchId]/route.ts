import { z } from "zod";

import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath, parseQuery } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import { getUphTestBatch } from "@/modules/uph/application/uph-test-batch-service";
import { uphApiErrorResponse } from "@/modules/uph/application/uph-api-errors";
import { getUphTestBatchQuerySchema } from "@/modules/uph/contracts/uph-test-batch-http";

const pathSchema = z.strictObject({
  projectId: z.string().trim().min(1).max(191),
  batchId: z.string().trim().min(1).max(191)
});
type Context = { params: Promise<{ projectId: string; batchId: string }> };

async function read(request: Request, context: Context) {
  try {
    const raw = await context.params;
    const path = parsePath(pathSchema, { projectId: raw.projectId, batchId: raw.batchId });
    const guard = await authorizeProjectRequest(
      request,
      path.projectId,
      PERMISSIONS.PROJECT_UPH_READ,
      {
        requireProjectMembership: true
      }
    );
    if (!guard.authorized) return guard.response;
    let query: { selection: "exact" | "currentWork" | "currentLocked"; revisionId?: string };
    try {
      query = parseQuery(request, getUphTestBatchQuerySchema);
    } catch (error) {
      if (error instanceof ApiContractError) {
        throw new ApiContractError(error.code, error.message, 422, error.issues);
      }
      throw error;
    }
    return Response.json(
      await getUphTestBatch({
        ...path,
        ...query,
        authorizationActor: guard.actor,
        projectMemberRoles: guard.project.memberRoles
      })
    );
  } catch (error) {
    return uphApiErrorResponse(error) ?? Promise.reject(error);
  }
}

export const GET = withRequestObservability({ module: "uph", operation: "read-test-batch" }, read);
