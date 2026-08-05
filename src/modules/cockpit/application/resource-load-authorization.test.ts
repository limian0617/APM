import { describe, expect, it, vi } from "vitest";

import type { AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS, PERMISSION_SCOPES, PROJECT_ROLES } from "@/lib/auth/permissions";
import type { ProjectAuthorizationTarget } from "@/lib/auth/repository";

import { authorizeResourceLoadPeopleRead } from "./resource-load-authorization";

const project: ProjectAuthorizationTarget = {
  id: "project-1",
  code: "APM-042",
  name: "Resource load",
  status: "IN_PROGRESS",
  version: 1,
  departmentId: "engineering",
  memberRoles: [PROJECT_ROLES.ENGINEER]
};

const auditContext = {
  actorId: "user-1",
  requestId: "request-1",
  traceId: null,
  source: "API" as const,
  sourceIp: null,
  userAgent: "Vitest",
  reason: null,
  projectId: project.id,
  departmentId: project.departmentId,
  operationId: "operation-1"
};

function actor(grants: AuthorizationActor["grants"]): AuthorizationActor {
  return {
    id: "user-1",
    name: "Resource reader",
    status: "ACTIVE",
    departmentId: "engineering",
    systemRoles: ["ENGINEER"],
    grants
  };
}

describe("APM-042 resource-load person authorization", () => {
  it("withholds people when the actor has aggregate read but no project-member read grant", async () => {
    const recordSensitiveRead = vi.fn();

    await expect(
      authorizeResourceLoadPeopleRead(
        {
          actor: actor([
            {
              permission: PERMISSIONS.PROJECT_READ,
              scope: PERMISSION_SCOPES.PROJECT,
              systemRole: "ENGINEER"
            }
          ]),
          project,
          projectionId: "projection-1",
          peopleCount: 2,
          auditContext
        },
        { recordSensitiveRead }
      )
    ).resolves.toBe(false);
    expect(recordSensitiveRead).not.toHaveBeenCalled();
  });

  it("audits a granted person-level read before returning personal data", async () => {
    const recordSensitiveRead = vi.fn().mockResolvedValue(undefined);

    await expect(
      authorizeResourceLoadPeopleRead(
        {
          actor: actor([
            {
              permission: PERMISSIONS.PROJECT_READ,
              scope: PERMISSION_SCOPES.PROJECT,
              systemRole: "ENGINEER"
            },
            {
              permission: PERMISSIONS.PROJECT_MEMBER_READ,
              scope: PERMISSION_SCOPES.PROJECT,
              systemRole: "ENGINEER"
            }
          ]),
          project,
          projectionId: "projection-1",
          peopleCount: 2,
          auditContext
        },
        { recordSensitiveRead }
      )
    ).resolves.toBe(true);
    expect(recordSensitiveRead).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "COCKPIT_RESOURCE_LOAD_PERSON_READ",
        objectId: "projection-1",
        context: expect.objectContaining({ actorId: "user-1", projectId: "project-1" })
      })
    );
  });
});
