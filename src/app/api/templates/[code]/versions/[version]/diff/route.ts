import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { compareProjectTemplateVersions } from "@/modules/configuration/application/template-service";
import { templateErrorResponse } from "@/modules/configuration/contracts/template-http";
import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { parsePath, parseQuery } from "@/modules/platform-api/contracts/dto";
import { apiContractErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  templateDiffQuerySchema,
  templateVersionPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

type RouteContext = { params: Promise<{ code: string; version: string }> };

async function compare(request: Request, context: RouteContext) {
  const raw = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONFIGURATION_READ,
    AUDIT_OBJECT_TYPES.TEMPLATE,
    raw.code
  );
  if (!guard.authorized) return guard.response;
  try {
    const path = parsePath(templateVersionPathSchema, raw);
    const query = parseQuery(request, templateDiffQuerySchema);
    return Response.json(
      await compareProjectTemplateVersions({
        code: path.code,
        fromVersion: path.version,
        toVersion: query.toVersion
      })
    );
  } catch (error) {
    return apiContractErrorResponse(error) ?? templateErrorResponse(error) ?? Promise.reject(error);
  }
}

export const GET = withRequestObservability(
  { module: "configuration-templates", operation: "compare-template-versions" },
  compare
);
