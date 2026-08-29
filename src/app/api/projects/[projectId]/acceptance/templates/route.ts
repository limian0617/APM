import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { listAcceptanceTemplateVersions } from "@/modules/acceptance/application/acceptance-service";
import {
  acceptanceServiceErrorResponse,
  acceptanceTemplateQuerySchema
} from "@/modules/acceptance/contracts/acceptance-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parseQuery } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";

type RouteContext = { params: Promise<{ projectId: string }> };

async function readTemplates(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const guard = await authorizeProjectRequest(request, projectId, PERMISSIONS.ACCEPTANCE_READ);
  if (!guard.authorized) return guard.response;
  try {
    const query = parseQuery(request, acceptanceTemplateQuerySchema);
    return Response.json(await listAcceptanceTemplateVersions({ projectId, ...query }));
  } catch (error) {
    return (
      apiContractErrorResponse(error) ??
      acceptanceServiceErrorResponse(error) ??
      Promise.reject(error)
    );
  }
}

export const GET = withRequestObservability(
  { module: "acceptance", operation: "list-template-versions" },
  readTemplates
);
