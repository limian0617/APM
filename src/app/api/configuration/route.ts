import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { getConfiguration } from "@/modules/configuration/application/configuration-service";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";

export async function GET(request: Request) {
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
