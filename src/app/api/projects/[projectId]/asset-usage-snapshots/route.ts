import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { getAssetUsageSnapshotForAcceptance } from "@/modules/assets/application/project-asset-usage-service";
import { projectAssetUsageErrorResponse } from "@/modules/assets/contracts/project-asset-usage-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import {
  projectAssetUsageSnapshotQuerySchema,
  projectPathSchema
} from "@/modules/platform-api/contracts/internal-routes";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import { parsePath, parseQuery } from "@/modules/platform-api/contracts/dto";

type Context = { params: Promise<{ projectId: string }> };

const errorResponse = (error: unknown) =>
  apiContractErrorResponse(error) ?? projectAssetUsageErrorResponse(error);

async function get(request: Request, context: Context) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(
    request,
    projectId,
    PERMISSIONS.PROJECT_ASSET_USAGE_READ,
    { requireProjectMembership: true }
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(projectPathSchema, { projectId });
    const query = parseQuery(request, projectAssetUsageSnapshotQuerySchema);
    const result = await getAssetUsageSnapshotForAcceptance({
      ...path,
      ...query,
      readAudit: {
        actorId: guard.actor.id,
        auditContext: auditContextFromRequest(request, {
          actorId: guard.actor.id,
          projectId: path.projectId,
          departmentId: guard.project.departmentId,
          reason: "read asset usage snapshot"
        })
      }
    });
    return Response.json({ ...result, allowedActions: [] });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const GET = withRequestObservability(
  { module: "assets", operation: "get-project-asset-usage-snapshot" },
  get
);
