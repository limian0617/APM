import { db } from "@/lib/db";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import type { AuditObjectType } from "@/modules/audit/domain/vocabulary";
import {
  AUDIT_ACTIONS,
  AUDIT_RESULTS,
  AUTHORIZATION_DENIAL_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";

import { decideAuthorization, type AuthorizationActor } from "./authorize";
import type { PermissionCode } from "./permissions";
import { loadAuthorizationActor } from "./repository";
import { readRequestIdentity } from "./request-identity";

type DenialRecord = {
  actorId: string;
  permission: PermissionCode;
  reason: string;
  objectType: AuditObjectType;
  objectId: string | null;
  method: string;
  path: string;
  auditContext: AuditContext;
};

export type SystemGuardDependencies = {
  loadActor(userId: string): Promise<AuthorizationActor | null>;
  recordDenial(record: DenialRecord): Promise<void>;
};

const defaultDependencies: SystemGuardDependencies = {
  loadActor: loadAuthorizationActor,
  async recordDenial(record) {
    await writeAudit(db, {
      action: AUDIT_ACTIONS.AUTHORIZATION_DENIED,
      objectType: record.objectType,
      objectId: record.objectId,
      result: AUDIT_RESULTS.DENIED,
      context: record.auditContext,
      metadata: {
        value: {
          permission: record.permission,
          method: record.method,
          path: record.path
        },
        allowedFields: AUTHORIZATION_DENIAL_AUDIT_FIELDS
      }
    });
  }
};

export type SystemGuardResult =
  { authorized: true; actor: AuthorizationActor } | { authorized: false; response: Response };

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export async function authorizeSystemRequest(
  request: Request,
  permission: PermissionCode,
  objectType: AuditObjectType,
  objectId: string | null = null,
  dependencies: SystemGuardDependencies = defaultDependencies
): Promise<SystemGuardResult> {
  const identity = readRequestIdentity(request);
  if (!identity.authenticated) {
    return {
      authorized: false,
      response: errorResponse(401, "UNAUTHENTICATED", "需要有效的用户身份。")
    };
  }

  const actor = await dependencies.loadActor(identity.userId);
  if (!actor) {
    return {
      authorized: false,
      response: errorResponse(401, "IDENTITY_UNKNOWN", "用户身份未在 APM 中登记。")
    };
  }

  const decision = decideAuthorization(actor, permission);
  if (decision.allowed) {
    return { authorized: true, actor };
  }

  const url = new URL(request.url);
  const auditContext = auditContextFromRequest(request, {
    actorId: actor.id,
    reason: decision.reason
  });
  try {
    await dependencies.recordDenial({
      actorId: actor.id,
      permission,
      reason: decision.reason,
      objectType,
      objectId,
      method: request.method,
      path: url.pathname,
      auditContext
    });
  } catch (error) {
    console.error("Unable to persist authorization denial audit", error);
  }

  return {
    authorized: false,
    response: errorResponse(403, "FORBIDDEN", "当前角色无权执行此系统操作。")
  };
}
