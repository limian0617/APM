import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeSystemRequest } from "@/lib/auth/system-guard";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { updateCompanyCapability } from "@/modules/configuration/application/configuration-service";
import {
  ConfigurationValidationError,
  isCapabilityCode
} from "@/modules/configuration/domain/definitions";
import { withRequestObservability } from "@/modules/observability/application/request-observer";

type RouteContext = { params: Promise<{ code: string }> };

async function updateCapability(request: Request, context: RouteContext) {
  const { code } = await context.params;
  const guard = await authorizeSystemRequest(
    request,
    PERMISSIONS.CONFIGURATION_WRITE,
    AUDIT_OBJECT_TYPES.COMPANY_CAPABILITY,
    code
  );
  if (!guard.authorized) {
    return guard.response;
  }

  try {
    if (!isCapabilityCode(code)) {
      throw new ConfigurationValidationError("UNKNOWN_CAPABILITY", "公司能力代码不存在。", 404);
    }
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
      await updateCompanyCapability({
        code,
        enabled: input.enabled,
        version: input.version,
        reason: input.reason,
        actorId: guard.actor.id,
        auditContext
      })
    );
  } catch (error) {
    if (error instanceof ConfigurationValidationError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status }
      );
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

export const PUT = withRequestObservability(
  { module: "configuration", operation: "update-capability" },
  updateCapability
);
