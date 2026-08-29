import { loadAuthorizationActor } from "@/lib/auth/repository";
import { readRequestIdentity } from "@/lib/auth/request-identity";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import {
  AuditQueryError,
  parseAuditQuery,
  queryAuditLogs
} from "@/modules/audit/application/query-audit";
import { withRequestObservability } from "@/modules/observability/application/request-observer";

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

async function listAudit(request: Request) {
  const identity = readRequestIdentity(request);
  if (!identity.authenticated) {
    return errorResponse(401, "UNAUTHENTICATED", "需要有效的用户身份。");
  }

  const actor = await loadAuthorizationActor(identity.userId);
  if (!actor) {
    return errorResponse(401, "IDENTITY_UNKNOWN", "用户身份未在 APM 中登记。");
  }

  try {
    const query = parseAuditQuery(new URL(request.url).searchParams);
    const context = auditContextFromRequest(request, { actorId: actor.id });
    return Response.json(await queryAuditLogs({ actor, query, context }));
  } catch (error) {
    if (error instanceof AuditQueryError) {
      return errorResponse(error.status, error.code, error.message);
    }
    throw error;
  }
}

export const GET = withRequestObservability({ module: "audit", operation: "list" }, listAudit);
