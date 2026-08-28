import { db } from "@/lib/db";

import {
  decideAuthorization,
  type AuthorizationActor,
  type AuthorizationContext
} from "./authorize";
import type { PermissionCode } from "./permissions";
import {
  loadAuthorizationActor,
  loadProjectAuthorizationTarget,
  type ProjectAuthorizationTarget
} from "./repository";
import { readRequestIdentity } from "./request-identity";
import { auditContextFromRequest } from "@/modules/audit/application/context";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_RESULTS,
  AUTHORIZATION_DENIAL_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";

type DenialRecord = {
  actorId: string;
  permission: PermissionCode;
  reason: string;
  projectId: string;
  method: string;
  path: string;
  auditContext: AuditContext;
};

export type ProjectGuardDependencies = {
  loadActor(userId: string): Promise<AuthorizationActor | null>;
  loadProject(projectId: string, actorId: string): Promise<ProjectAuthorizationTarget | null>;
  recordDenial(record: DenialRecord): Promise<void>;
};

const defaultDependencies: ProjectGuardDependencies = {
  loadActor: loadAuthorizationActor,
  loadProject: loadProjectAuthorizationTarget,
  async recordDenial(record) {
    await writeAudit(db, {
      action: AUDIT_ACTIONS.AUTHORIZATION_DENIED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT,
      objectId: record.projectId,
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

export type ProjectGuardResult =
  | { authorized: true; actor: AuthorizationActor; project: ProjectAuthorizationTarget }
  | { authorized: false; response: Response };

type ProjectAuthorizationContext = Omit<AuthorizationContext, "projectId" | "memberRoles">;
type ProjectAuthorizationContextResolver = (input: {
  actor: AuthorizationActor;
  project: ProjectAuthorizationTarget;
}) => Promise<ProjectAuthorizationContext>;

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export async function authorizeProjectRequest(
  request: Request,
  projectId: string,
  permission: PermissionCode,
  context: ProjectAuthorizationContext | ProjectAuthorizationContextResolver = {},
  dependencies: ProjectGuardDependencies = defaultDependencies
): Promise<ProjectGuardResult> {
  const identity = readRequestIdentity(request);
  if (!identity.authenticated) {
    return {
      authorized: false,
      response: jsonError(401, "UNAUTHENTICATED", "需要有效的用户身份。")
    };
  }

  const actor = await dependencies.loadActor(identity.userId);
  if (!actor) {
    return {
      authorized: false,
      response: jsonError(401, "IDENTITY_UNKNOWN", "用户身份未在 APM 中登记。")
    };
  }

  const project = await dependencies.loadProject(projectId, actor.id);
  if (!project) {
    return {
      authorized: false,
      response: jsonError(404, "PROJECT_NOT_FOUND", "项目不存在。")
    };
  }

  const authorizationContext =
    typeof context === "function" ? await context({ actor, project }) : context;
  const decision = decideAuthorization(actor, permission, {
    ...authorizationContext,
    projectId: project.id,
    resourceDepartmentId: authorizationContext.resourceDepartmentId ?? project.departmentId,
    memberRoles: project.memberRoles
  });

  if (decision.allowed) {
    return { authorized: true, actor, project };
  }

  const url = new URL(request.url);
  const auditContext = auditContextFromRequest(request, {
    actorId: actor.id,
    projectId: project.id,
    departmentId: project.departmentId,
    reason: decision.reason
  });
  try {
    await dependencies.recordDenial({
      actorId: actor.id,
      permission,
      reason: decision.reason,
      projectId: project.id,
      method: request.method,
      path: url.pathname,
      auditContext
    });
  } catch (error) {
    console.error("Unable to persist authorization denial audit", error);
  }

  return {
    authorized: false,
    response: jsonError(403, "FORBIDDEN", "当前角色无权执行此项目操作。")
  };
}
