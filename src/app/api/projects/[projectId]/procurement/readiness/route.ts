import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath, parseQuery } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  procurementReadinessQuerySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";
import { readProcurementReadinessTree } from "@/modules/procurement/application/readiness-service";

type RouteContext = { params: Promise<{ projectId: string }> };

async function getReadiness(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.PROJECT_PROCUREMENT_READ
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const query = parseQuery(request, procurementReadinessQuerySchema);
    const tree = await readProcurementReadinessTree({ projectId: path.projectId });
    const root = tree.scopes.find(
      (scope) => scope.scopeType === "PROJECT" && scope.scopeId === path.projectId
    );
    return Response.json({
      projectId: path.projectId,
      view: query.view,
      status: root?.status ?? "EMPTY",
      formulaVersion: root?.formulaVersion ?? null,
      inputWatermark: tree.inputWatermark,
      calculatedAt: root?.calculatedAt ?? null,
      sourceSyncedAt: root?.sourceSyncedAt ?? null,
      stale: tree.stale,
      scopes: tree.scopes
    });
  } catch (error) {
    return apiContractErrorResponse(error) ?? Promise.reject(error);
  }
}

export const GET = withRequestObservability(
  { module: "procurement", operation: "read-procurement-readiness" },
  getReadiness
);
