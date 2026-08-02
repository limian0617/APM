import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { updateSystemSetting } from "@/modules/configuration/application/configuration-service";
import { ConfigurationValidationError } from "@/modules/configuration/domain/definitions";

type RouteContext = { params: Promise<{ key: string }> };

function errorResponse(error: ConfigurationValidationError): Response {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status }
  );
}

export async function PUT(request: Request, context: RouteContext) {
  const { key } = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONFIGURATION_WRITE,
    AUDIT_OBJECT_TYPES.SYSTEM_SETTING,
    key
  );
  if (!guard.authorized) {
    return guard.response;
  }

  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ConfigurationValidationError("INVALID_VALUE", "请求体必须是 JSON 对象。", 422);
    }
    const input = body as Record<string, unknown>;
    const auditContext = auditContextFromRequest(request, {
      actorId: guard.actor.id,
      reason: typeof input.reason === "string" ? input.reason : null
    });
    return Response.json(
      await updateSystemSetting({
        key,
        value: input.value,
        version: input.version,
        reason: input.reason,
        actorId: guard.actor.id,
        auditContext
      })
    );
  } catch (error) {
    if (error instanceof ConfigurationValidationError) {
      return errorResponse(error);
    }
    if (error instanceof SyntaxError) {
      return Response.json(
        { error: { code: "INVALID_JSON", message: "请求体不是有效 JSON。" } },
        { status: 400 }
      );
    }
    throw error;
  }
}
