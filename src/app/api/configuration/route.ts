import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { getConfiguration } from "@/modules/configuration/application/configuration-service";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { withRequestObservability } from "@/modules/observability/application/request-observer";

async function readConfiguration(request: Request) {
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONFIGURATION_READ,
    AUDIT_OBJECT_TYPES.SYSTEM_SETTING
  );
  if (!guard.authorized) {
    return guard.response;
  }

  return Response.json(await getConfiguration());
}

export const GET = withRequestObservability(
  { module: "configuration", operation: "read" },
  readConfiguration
);
