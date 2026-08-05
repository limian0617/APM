import { describe, expect, it, vi } from "vitest";

import type { AuthorizationActor } from "./authorize";
import { PERMISSIONS, PERMISSION_SCOPES, SYSTEM_ROLES } from "./permissions";
import { authorizeProjectRequest, type ProjectGuardDependencies } from "./project-guard";

describe("APM-060 project-member requirement", () => {
  it("denies a global document grant when a public-library reference actor is not an active project member", async () => {
    const dependencies: ProjectGuardDependencies = {
      loadActor: vi.fn(async (): Promise<AuthorizationActor> => ({
        id: "library-admin-1",
        name: "资料管理员",
        status: "ACTIVE",
        departmentId: "engineering",
        systemRoles: [SYSTEM_ROLES.ADMIN],
        grants: [
          {
            permission: PERMISSIONS.CONTROLLED_DOCUMENT_MANAGE,
            scope: PERMISSION_SCOPES.ALL,
            systemRole: SYSTEM_ROLES.ADMIN
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
        memberRoles: []
      })),
      recordDenial: vi.fn(async () => undefined)
    };

    const result = await authorizeProjectRequest(
      new Request("http://localhost/api/projects/project-1/public-library-references", {
        method: "POST",
        headers: { "x-apm-user-id": "library-admin-1" }
      }),
      "project-1",
      PERMISSIONS.CONTROLLED_DOCUMENT_MANAGE,
      { requireProjectMembership: true },
      dependencies
    );

    expect(result.authorized).toBe(false);
    if (!result.authorized) {
      expect(result.response.status).toBe(403);
    }
    expect(dependencies.recordDenial).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: PERMISSIONS.CONTROLLED_DOCUMENT_MANAGE,
        reason: "PROJECT_MEMBERSHIP_REQUIRED"
      })
    );
  });
});
