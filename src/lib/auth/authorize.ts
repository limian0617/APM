import {
  PERMISSIONS,
  PERMISSION_SCOPES,
  PROJECT_ROLES,
  type PermissionCode,
  type PermissionScope,
  type ProjectRoleCode,
  type SystemRoleCode
} from "./permissions";

export type PermissionGrant = {
  permission: string;
  scope: PermissionScope;
  systemRole: string;
};

export type AuthorizationActor = {
  id: string;
  name: string;
  status: "ACTIVE" | "DISABLED";
  departmentId: string | null;
  systemRoles: string[];
  grants: PermissionGrant[];
};

export type AuthorizationContext = {
  projectId?: string;
  resourceDepartmentId?: string | null;
  resourceOwnerId?: string | null;
  memberRoles?: string[];
  assignedUserIds?: string[];
  assignedSystemRoles?: string[];
  assignedProjectRoles?: string[];
};

export type AuthorizationDecision =
  | { allowed: true; scope: PermissionScope; systemRole: string }
  | {
      allowed: false;
      reason:
        | "ACTOR_DISABLED"
        | "PERMISSION_NOT_GRANTED"
        | "PROJECT_MEMBERSHIP_REQUIRED"
        | "PROJECT_ROLE_NOT_ALLOWED"
        | "DEPARTMENT_SCOPE_MISMATCH"
        | "RESOURCE_OWNER_MISMATCH"
        | "APPROVAL_ASSIGNMENT_REQUIRED";
    };

const projectRolesByPermission: Partial<Record<PermissionCode, ProjectRoleCode[]>> = {
  [PERMISSIONS.PROJECT_PLAN_UPDATE]: [PROJECT_ROLES.PROJECT_MANAGER, PROJECT_ROLES.DEPARTMENT_LEAD],
  [PERMISSIONS.PROJECT_ALERT_MANAGE]: [
    PROJECT_ROLES.PROJECT_MANAGER,
    PROJECT_ROLES.DEPARTMENT_LEAD
  ],
  [PERMISSIONS.PROJECT_ALERT_ACTION]: [
    PROJECT_ROLES.PROJECT_MANAGER,
    PROJECT_ROLES.DEPARTMENT_LEAD,
    PROJECT_ROLES.ENGINEER,
    PROJECT_ROLES.PROCUREMENT,
    PROJECT_ROLES.QUALITY
  ],
  [PERMISSIONS.TASK_PROGRESS_UPDATE]: [
    PROJECT_ROLES.PROJECT_MANAGER,
    PROJECT_ROLES.DEPARTMENT_LEAD,
    PROJECT_ROLES.ENGINEER,
    PROJECT_ROLES.PROCUREMENT,
    PROJECT_ROLES.QUALITY
  ],
  [PERMISSIONS.GATE_SUBMIT]: [PROJECT_ROLES.PROJECT_MANAGER],
  [PERMISSIONS.CONTROLLED_DOCUMENT_MANAGE]: [
    PROJECT_ROLES.PROJECT_MANAGER,
    PROJECT_ROLES.DEPARTMENT_LEAD,
    PROJECT_ROLES.ENGINEER,
    PROJECT_ROLES.PROCUREMENT,
    PROJECT_ROLES.QUALITY
  ],
  [PERMISSIONS.ACCEPTANCE_RESULT_UPDATE]: [
    PROJECT_ROLES.PROJECT_MANAGER,
    PROJECT_ROLES.ENGINEER,
    PROJECT_ROLES.QUALITY
  ],
  [PERMISSIONS.ACCEPTANCE_EVIDENCE_MANAGE]: [PROJECT_ROLES.PROJECT_MANAGER, PROJECT_ROLES.QUALITY],
  [PERMISSIONS.ACCEPTANCE_REVIEW]: [PROJECT_ROLES.QUALITY],
  [PERMISSIONS.PROJECT_MEMBER_MANAGE]: [PROJECT_ROLES.PROJECT_MANAGER]
};

function hasRequiredProjectRole(permission: PermissionCode, memberRoles: string[]): boolean {
  const requiredRoles = projectRolesByPermission[permission];
  return !requiredRoles || requiredRoles.some((role) => memberRoles.includes(role));
}

function decideForGrant(
  actor: AuthorizationActor,
  permission: PermissionCode,
  grant: PermissionGrant,
  context: AuthorizationContext
): AuthorizationDecision {
  const memberRoles = context.memberRoles ?? [];

  if (grant.scope === PERMISSION_SCOPES.ALL) {
    return { allowed: true, scope: grant.scope, systemRole: grant.systemRole };
  }

  if (grant.scope === PERMISSION_SCOPES.PROJECT) {
    if (!context.projectId || memberRoles.length === 0) {
      return { allowed: false, reason: "PROJECT_MEMBERSHIP_REQUIRED" };
    }

    return hasRequiredProjectRole(permission, memberRoles)
      ? { allowed: true, scope: grant.scope, systemRole: grant.systemRole }
      : { allowed: false, reason: "PROJECT_ROLE_NOT_ALLOWED" };
  }

  if (grant.scope === PERMISSION_SCOPES.DEPARTMENT) {
    if (
      !actor.departmentId ||
      !context.resourceDepartmentId ||
      actor.departmentId !== context.resourceDepartmentId
    ) {
      return { allowed: false, reason: "DEPARTMENT_SCOPE_MISMATCH" };
    }

    return hasRequiredProjectRole(permission, memberRoles)
      ? { allowed: true, scope: grant.scope, systemRole: grant.systemRole }
      : { allowed: false, reason: "PROJECT_ROLE_NOT_ALLOWED" };
  }

  if (grant.scope === PERMISSION_SCOPES.SELF) {
    if (!context.projectId || memberRoles.length === 0) {
      return { allowed: false, reason: "PROJECT_MEMBERSHIP_REQUIRED" };
    }
    if (!context.resourceOwnerId || context.resourceOwnerId !== actor.id) {
      return { allowed: false, reason: "RESOURCE_OWNER_MISMATCH" };
    }

    return hasRequiredProjectRole(permission, memberRoles)
      ? { allowed: true, scope: grant.scope, systemRole: grant.systemRole }
      : { allowed: false, reason: "PROJECT_ROLE_NOT_ALLOWED" };
  }

  const assignedDirectly = context.assignedUserIds?.includes(actor.id) ?? false;
  const assignedBySystemRole = context.assignedSystemRoles?.some((role) =>
    actor.systemRoles.includes(role as SystemRoleCode)
  );
  const assignedByProjectRole = context.assignedProjectRoles?.some((role) =>
    memberRoles.includes(role as ProjectRoleCode)
  );

  return assignedDirectly || assignedBySystemRole || assignedByProjectRole
    ? { allowed: true, scope: grant.scope, systemRole: grant.systemRole }
    : { allowed: false, reason: "APPROVAL_ASSIGNMENT_REQUIRED" };
}

export function decideAuthorization(
  actor: AuthorizationActor,
  permission: PermissionCode,
  context: AuthorizationContext = {}
): AuthorizationDecision {
  if (actor.status !== "ACTIVE") {
    return { allowed: false, reason: "ACTOR_DISABLED" };
  }

  const grants = actor.grants.filter((grant) => grant.permission === permission);
  if (grants.length === 0) {
    return { allowed: false, reason: "PERMISSION_NOT_GRANTED" };
  }

  let denied: AuthorizationDecision = { allowed: false, reason: "PERMISSION_NOT_GRANTED" };
  for (const grant of grants) {
    const decision = decideForGrant(actor, permission, grant, context);
    if (decision.allowed) {
      return decision;
    }
    denied = decision;
  }

  return denied;
}
