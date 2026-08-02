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

type DenialRecord = {
  actorId: string;
  permission: PermissionCode;
  reason: string;
  projectId: string;
  method: string;
  path: string;
  sourceIp: string | null;
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
    await db.auditLog.create({
      data: {
        actorId: record.actorId,
        action: "AUTHORIZATION_DENIED",
        objectType: "PROJECT",
        objectId: record.projectId,
        afterJson: {
          permission: record.permission,
          reason: record.reason,
          method: record.method,
          path: record.path
        },
        source: "API",
        sourceIp: record.sourceIp
      }
    });
  }
};

export type ProjectGuardResult =
  | { authorized: true; actor: AuthorizationActor; project: ProjectAuthorizationTarget }
  | { authorized: false; response: Response };

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export async function authorizeProjectRequest(
  request: Request,
  projectId: string,
  permission: PermissionCode,
  context: Omit<AuthorizationContext, "projectId" | "memberRoles"> = {},
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

  const decision = decideAuthorization(actor, permission, {
    ...context,
    projectId: project.id,
    resourceDepartmentId: context.resourceDepartmentId ?? project.departmentId,
    memberRoles: project.memberRoles
  });

  if (decision.allowed) {
    return { authorized: true, actor, project };
  }

  const url = new URL(request.url);
  const sourceIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  try {
    await dependencies.recordDenial({
      actorId: actor.id,
      permission,
      reason: decision.reason,
      projectId: project.id,
      method: request.method,
      path: url.pathname,
      sourceIp
    });
  } catch (error) {
    console.error("Unable to persist authorization denial audit", error);
  }

  return {
    authorized: false,
    response: jsonError(403, "FORBIDDEN", "当前角色无权执行此项目操作。")
  };
}
