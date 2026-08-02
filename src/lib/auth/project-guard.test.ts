import { describe, expect, it, vi } from "vitest";

import type { AuthorizationActor } from "./authorize";
import { PERMISSIONS, PERMISSION_SCOPES, PROJECT_ROLES, SYSTEM_ROLES } from "./permissions";
import { authorizeProjectRequest, type ProjectGuardDependencies } from "./project-guard";

function dependencies(): ProjectGuardDependencies {
  return {
    loadActor: vi.fn(async (): Promise<AuthorizationActor> => ({
      id: "engineer-1",
      name: "工程师",
      status: "ACTIVE",
      departmentId: "mechanical",
      systemRoles: [SYSTEM_ROLES.ENGINEER],
      grants: [
        {
          permission: PERMISSIONS.PROJECT_MEMBER_READ,
          scope: PERMISSION_SCOPES.PROJECT,
          systemRole: SYSTEM_ROLES.ENGINEER
        }
      ]
    })),
    loadProject: vi.fn(async () => ({
      id: "project-1",
      code: "APM-TEST-001",
      name: "测试项目",
      status: "IN_PROGRESS",
      version: 3,
      departmentId: "mechanical",
      memberRoles: [PROJECT_ROLES.ENGINEER]
    })),
    recordDenial: vi.fn(async () => undefined)
  };
}

describe("authorizeProjectRequest", () => {
  it("returns 401 before any data access when identity is missing", async () => {
    const deps = dependencies();
    const result = await authorizeProjectRequest(
      new Request("http://localhost/api/projects/project-1/members"),
      "project-1",
      PERMISSIONS.PROJECT_MEMBER_READ,
      {},
      deps
    );

    expect(result.authorized).toBe(false);
    if (!result.authorized) {
      expect(result.response.status).toBe(401);
    }
    expect(deps.loadActor).not.toHaveBeenCalled();
    expect(deps.recordDenial).not.toHaveBeenCalled();
  });

  it("allows an active project member to read the member list", async () => {
    const deps = dependencies();
    const request = new Request("http://localhost/api/projects/project-1/members", {
      headers: { "x-apm-user-id": "engineer-1" }
    });
    const result = await authorizeProjectRequest(
      request,
      "project-1",
      PERMISSIONS.PROJECT_MEMBER_READ,
      {},
      deps
    );

    expect(result.authorized).toBe(true);
    expect(deps.recordDenial).not.toHaveBeenCalled();
  });

  it("returns 403 and records a structured denial for an unauthorized API call", async () => {
    const deps = dependencies();
    const request = new Request("http://localhost/api/projects/project-1/members", {
      method: "POST",
      headers: {
        "x-apm-user-id": "engineer-1",
        "x-forwarded-for": "10.0.0.8, 10.0.0.1"
      }
    });
    const result = await authorizeProjectRequest(
      request,
      "project-1",
      PERMISSIONS.PROJECT_MEMBER_MANAGE,
      {},
      deps
    );

    expect(result.authorized).toBe(false);
    if (!result.authorized) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toMatchObject({
        error: { code: "FORBIDDEN" }
      });
    }
    expect(deps.recordDenial).toHaveBeenCalledWith({
      actorId: "engineer-1",
      permission: PERMISSIONS.PROJECT_MEMBER_MANAGE,
      reason: "PERMISSION_NOT_GRANTED",
      projectId: "project-1",
      method: "POST",
      path: "/api/projects/project-1/members",
      sourceIp: "10.0.0.8"
    });
  });

  it("uses a supplied resource department for department-scoped objects", async () => {
    const deps = dependencies();
    deps.loadActor = vi.fn(async (): Promise<AuthorizationActor> => ({
      id: "lead-1",
      name: "部门负责人",
      status: "ACTIVE",
      departmentId: "mechanical",
      systemRoles: [SYSTEM_ROLES.DEPARTMENT_LEAD],
      grants: [
        {
          permission: PERMISSIONS.PROJECT_PLAN_UPDATE,
          scope: PERMISSION_SCOPES.DEPARTMENT,
          systemRole: SYSTEM_ROLES.DEPARTMENT_LEAD
        }
      ]
    }));
    deps.loadProject = vi.fn(async () => ({
      id: "project-1",
      code: "APM-TEST-001",
      name: "测试项目",
      status: "IN_PROGRESS",
      version: 3,
      departmentId: "electrical",
      memberRoles: [PROJECT_ROLES.DEPARTMENT_LEAD]
    }));

    const result = await authorizeProjectRequest(
      new Request("http://localhost/api/projects/project-1/tasks/task-1", {
        method: "PATCH",
        headers: { "x-apm-user-id": "lead-1" }
      }),
      "project-1",
      PERMISSIONS.PROJECT_PLAN_UPDATE,
      { resourceDepartmentId: "mechanical" },
      deps
    );

    expect(result.authorized).toBe(true);
  });
});
