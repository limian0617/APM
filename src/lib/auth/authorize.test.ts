import { describe, expect, it } from "vitest";

import {
  PERMISSIONS,
  PERMISSION_SCOPES,
  PROJECT_ROLES,
  SYSTEM_ROLES,
  type PermissionCode,
  type PermissionScope
} from "./permissions";
import { decideAuthorization, type AuthorizationActor } from "./authorize";

function actor(input: Partial<AuthorizationActor> = {}): AuthorizationActor {
  return {
    id: "user-1",
    name: "测试用户",
    status: "ACTIVE",
    departmentId: "mechanical",
    systemRoles: [],
    grants: [],
    ...input
  };
}

function grant(permission: PermissionCode, scope: PermissionScope, systemRole: string) {
  return { permission, scope, systemRole };
}

describe("decideAuthorization", () => {
  it.each([
    [
      PERMISSIONS.PROJECT_UPH_BATCH_MANAGE,
      PROJECT_ROLES.ENGINEER,
      PROJECT_ROLES.PROJECT_MANAGER,
      SYSTEM_ROLES.ENGINEER
    ],
    [
      PERMISSIONS.PROJECT_UPH_BATCH_CONFIRM,
      PROJECT_ROLES.PROJECT_MANAGER,
      PROJECT_ROLES.QUALITY,
      SYSTEM_ROLES.PROJECT_MANAGER
    ],
    [
      PERMISSIONS.PROJECT_UPH_BATCH_LOCK,
      PROJECT_ROLES.QUALITY,
      PROJECT_ROLES.ENGINEER,
      SYSTEM_ROLES.QUALITY
    ],
    [
      PERMISSIONS.PROJECT_UPH_ANALYZE,
      PROJECT_ROLES.ENGINEER,
      PROJECT_ROLES.DEPARTMENT_LEAD,
      SYSTEM_ROLES.ENGINEER
    ]
  ] as const)(
    "enforces the dedicated %s project role and default-deny boundaries",
    (permission, allowedRole, wrongRole, systemRole) => {
      const granted = actor({
        systemRoles: [systemRole],
        grants: [grant(permission, PERMISSION_SCOPES.PROJECT, systemRole)]
      });

      expect(
        decideAuthorization(granted, permission, {
          projectId: "project-uph-081",
          requireProjectMembership: true,
          memberRoles: [allowedRole]
        })
      ).toMatchObject({ allowed: true, scope: "PROJECT" });
      expect(
        decideAuthorization(granted, permission, {
          projectId: "project-uph-081",
          requireProjectMembership: true,
          memberRoles: [wrongRole]
        })
      ).toEqual({ allowed: false, reason: "PROJECT_ROLE_NOT_ALLOWED" });
      expect(
        decideAuthorization(actor(), permission, {
          projectId: "project-uph-081",
          requireProjectMembership: true,
          memberRoles: [allowedRole]
        })
      ).toEqual({ allowed: false, reason: "PERMISSION_NOT_GRANTED" });
      expect(
        decideAuthorization(granted, permission, {
          projectId: "project-uph-081",
          requireProjectMembership: true,
          memberRoles: []
        })
      ).toEqual({ allowed: false, reason: "PROJECT_MEMBERSHIP_REQUIRED" });
    }
  );

  it("exposes dedicated retrospective and knowledge permissions", () => {
    expect(PERMISSIONS.PROJECT_RETROSPECTIVE_MANAGE).toBe("PROJECT_RETROSPECTIVE_MANAGE");
    expect(PERMISSIONS.PROJECT_RETROSPECTIVE_REVIEW).toBe("PROJECT_RETROSPECTIVE_REVIEW");
    expect(PERMISSIONS.PROJECT_RETROSPECTIVE_READ).toBe("PROJECT_RETROSPECTIVE_READ");
    expect(PERMISSIONS.KNOWLEDGE_REVIEW).toBe("KNOWLEDGE_REVIEW");
    expect(PERMISSIONS.KNOWLEDGE_READ).toBe("KNOWLEDGE_READ");
    expect(PERMISSIONS.KNOWLEDGE_REUSE_CONFIRM).toBe("KNOWLEDGE_REUSE_CONFIRM");
  });

  it("applies the recovery permission scopes without granting source facts to a global knowledge reviewer", () => {
    const sourceManager = actor({
      systemRoles: [SYSTEM_ROLES.PROJECT_MANAGER],
      grants: [
        grant(
          PERMISSIONS.PROJECT_RETROSPECTIVE_MANAGE,
          PERMISSION_SCOPES.PROJECT,
          SYSTEM_ROLES.PROJECT_MANAGER
        )
      ]
    });
    const quality = actor({
      systemRoles: [SYSTEM_ROLES.QUALITY],
      grants: [
        grant(
          PERMISSIONS.PROJECT_RETROSPECTIVE_REVIEW,
          PERMISSION_SCOPES.PROJECT,
          SYSTEM_ROLES.QUALITY
        )
      ]
    });
    const knowledgeReviewer = actor({
      systemRoles: [SYSTEM_ROLES.DEPARTMENT_LEAD],
      grants: [
        grant(PERMISSIONS.KNOWLEDGE_REVIEW, PERMISSION_SCOPES.ALL, SYSTEM_ROLES.DEPARTMENT_LEAD)
      ]
    });

    expect(
      decideAuthorization(sourceManager, PERMISSIONS.PROJECT_RETROSPECTIVE_MANAGE, {
        projectId: "source-project",
        memberRoles: [PROJECT_ROLES.PROJECT_MANAGER]
      })
    ).toMatchObject({ allowed: true });
    expect(
      decideAuthorization(quality, PERMISSIONS.PROJECT_RETROSPECTIVE_REVIEW, {
        projectId: "source-project",
        memberRoles: [PROJECT_ROLES.QUALITY]
      })
    ).toMatchObject({ allowed: true });
    expect(decideAuthorization(knowledgeReviewer, PERMISSIONS.PROJECT_RETROSPECTIVE_READ)).toEqual({
      allowed: false,
      reason: "PERMISSION_NOT_GRANTED"
    });
  });
  it("allows an administrator with company-wide member management", () => {
    const decision = decideAuthorization(
      actor({
        systemRoles: [SYSTEM_ROLES.ADMIN],
        grants: [
          grant(PERMISSIONS.PROJECT_MEMBER_MANAGE, PERMISSION_SCOPES.ALL, SYSTEM_ROLES.ADMIN)
        ]
      }),
      PERMISSIONS.PROJECT_MEMBER_MANAGE,
      { projectId: "project-1", memberRoles: [] }
    );

    expect(decision).toMatchObject({ allowed: true, scope: "ALL" });
  });

  it("requires both the system grant and the project-manager project role", () => {
    const projectManager = actor({
      systemRoles: [SYSTEM_ROLES.PROJECT_MANAGER],
      grants: [
        grant(
          PERMISSIONS.PROJECT_MEMBER_MANAGE,
          PERMISSION_SCOPES.PROJECT,
          SYSTEM_ROLES.PROJECT_MANAGER
        )
      ]
    });

    expect(
      decideAuthorization(projectManager, PERMISSIONS.PROJECT_MEMBER_MANAGE, {
        projectId: "project-1",
        memberRoles: [PROJECT_ROLES.PROJECT_MANAGER]
      })
    ).toMatchObject({ allowed: true });
    expect(
      decideAuthorization(projectManager, PERMISSIONS.PROJECT_MEMBER_MANAGE, {
        projectId: "project-1",
        memberRoles: [PROJECT_ROLES.ENGINEER]
      })
    ).toEqual({ allowed: false, reason: "PROJECT_ROLE_NOT_ALLOWED" });
  });

  it("limits an engineer task update to a resource owned by that engineer", () => {
    const engineer = actor({
      systemRoles: [SYSTEM_ROLES.ENGINEER],
      grants: [
        grant(PERMISSIONS.TASK_PROGRESS_UPDATE, PERMISSION_SCOPES.SELF, SYSTEM_ROLES.ENGINEER)
      ]
    });
    const baseContext = {
      projectId: "project-1",
      memberRoles: [PROJECT_ROLES.ENGINEER]
    };

    expect(
      decideAuthorization(engineer, PERMISSIONS.TASK_PROGRESS_UPDATE, {
        ...baseContext,
        resourceOwnerId: engineer.id
      })
    ).toMatchObject({ allowed: true });
    expect(
      decideAuthorization(engineer, PERMISSIONS.TASK_PROGRESS_UPDATE, {
        ...baseContext,
        resourceOwnerId: "user-2"
      })
    ).toEqual({ allowed: false, reason: "RESOURCE_OWNER_MISMATCH" });
  });

  it("limits department-level plan edits to the same department and project role", () => {
    const departmentLead = actor({
      systemRoles: [SYSTEM_ROLES.DEPARTMENT_LEAD],
      grants: [
        grant(
          PERMISSIONS.PROJECT_PLAN_UPDATE,
          PERMISSION_SCOPES.DEPARTMENT,
          SYSTEM_ROLES.DEPARTMENT_LEAD
        )
      ]
    });

    expect(
      decideAuthorization(departmentLead, PERMISSIONS.PROJECT_PLAN_UPDATE, {
        projectId: "project-1",
        resourceDepartmentId: "mechanical",
        memberRoles: [PROJECT_ROLES.DEPARTMENT_LEAD]
      })
    ).toMatchObject({ allowed: true });
    expect(
      decideAuthorization(departmentLead, PERMISSIONS.PROJECT_PLAN_UPDATE, {
        projectId: "project-2",
        resourceDepartmentId: "electrical",
        memberRoles: [PROJECT_ROLES.DEPARTMENT_LEAD]
      })
    ).toEqual({ allowed: false, reason: "DEPARTMENT_SCOPE_MISMATCH" });
  });

  it("does not infer Gate approval from a system role without template assignment", () => {
    const quality = actor({
      systemRoles: [SYSTEM_ROLES.QUALITY],
      grants: [grant(PERMISSIONS.GATE_APPROVE, PERMISSION_SCOPES.ASSIGNED, SYSTEM_ROLES.QUALITY)]
    });

    expect(
      decideAuthorization(quality, PERMISSIONS.GATE_APPROVE, {
        projectId: "project-1",
        memberRoles: [PROJECT_ROLES.QUALITY]
      })
    ).toEqual({ allowed: false, reason: "APPROVAL_ASSIGNMENT_REQUIRED" });
    expect(
      decideAuthorization(quality, PERMISSIONS.GATE_APPROVE, {
        projectId: "project-1",
        memberRoles: [PROJECT_ROLES.QUALITY],
        assignedSystemRoles: [SYSTEM_ROLES.QUALITY]
      })
    ).toMatchObject({ allowed: true, scope: "ASSIGNED" });
  });

  it("keeps executives read-only unless they are assigned an approval", () => {
    const executive = actor({
      systemRoles: [SYSTEM_ROLES.EXECUTIVE],
      grants: [grant(PERMISSIONS.PROJECT_READ, PERMISSION_SCOPES.ALL, SYSTEM_ROLES.EXECUTIVE)]
    });

    expect(decideAuthorization(executive, PERMISSIONS.PROJECT_READ)).toMatchObject({
      allowed: true
    });
    expect(decideAuthorization(executive, PERMISSIONS.PROJECT_PLAN_UPDATE)).toEqual({
      allowed: false,
      reason: "PERMISSION_NOT_GRANTED"
    });
  });

  it("rejects disabled users even when a grant exists", () => {
    const disabled = actor({
      status: "DISABLED",
      grants: [grant(PERMISSIONS.PROJECT_READ, PERMISSION_SCOPES.ALL, SYSTEM_ROLES.ADMIN)]
    });

    expect(decideAuthorization(disabled, PERMISSIONS.PROJECT_READ)).toEqual({
      allowed: false,
      reason: "ACTOR_DISABLED"
    });
  });
});
