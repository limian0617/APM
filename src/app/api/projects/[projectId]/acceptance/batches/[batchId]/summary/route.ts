import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { getAcceptanceSummary } from "@/modules/acceptance/application/acceptance-service";
import {
  acceptanceBatchPathSchema,
  acceptanceServiceErrorResponse
} from "@/modules/acceptance/contracts/acceptance-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";

type RouteContext = { params: Promise<{ projectId: string; batchId: string }> };

async function readSummary(request: Request, context: RouteContext) {
  const params = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    params.projectId,
    PERMISSIONS.ACCEPTANCE_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(acceptanceBatchPathSchema, params);
    return Response.json(await getAcceptanceSummary(path.projectId, path.batchId));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      acceptanceServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "acceptance", operation: "read-summary" },
  readSummary
);
