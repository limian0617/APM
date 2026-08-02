import { describe, expect, it, vi } from "vitest";

import { AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";

import type { AuthorizationActor } from "./authorize";
import { PERMISSIONS, PERMISSION_SCOPES, SYSTEM_ROLES } from "./permissions";
import { authorizeSystemRequest, type SystemGuardDependencies } from "./system-guard";

function actor(permission: string): AuthorizationActor {
  return {
    id: "admin-1",
    name: "系统管理员",
    status: "ACTIVE",
    departmentId: "hq",
    systemRoles: [SYSTEM_ROLES.ADMIN],
    grants: [{ permission, scope: PERMISSION_SCOPES.ALL, systemRole: SYSTEM_ROLES.ADMIN }]
  };
}

function dependencies(permission: string): SystemGuardDependencies {
  return {
    loadActor: vi.fn(async () => actor(permission)),
    recordDenial: vi.fn(async () => undefined)
  };
}

describe("authorizeSystemRequest", () => {
  it("rejects missing identities before repository access", async () => {
    const deps = dependencies(PERMISSIONS.CONFIGURATION_READ);
    const result = await authorizeSystemRequest(
      new Request("http://localhost/api/configuration"),
      PERMISSIONS.CONFIGURATION_READ,
      AUDIT_OBJECT_TYPES.SYSTEM_SETTING,
      null,
      deps
    );
    expect(result.authorized).toBe(false);
    if (!result.authorized) expect(result.response.status).toBe(401);
    expect(deps.loadActor).not.toHaveBeenCalled();
  });

  it("allows an ALL-scoped system permission", async () => {
    const deps = dependencies(PERMISSIONS.CONFIGURATION_WRITE);
    const result = await authorizeSystemRequest(
      new Request("http://localhost/api/configuration/settings/jobs.claimBatchSize", {
        method: "PUT",
        headers: { "x-apm-user-id": "admin-1" }
      }),
      PERMISSIONS.CONFIGURATION_WRITE,
      AUDIT_OBJECT_TYPES.SYSTEM_SETTING,
      "jobs.claimBatchSize",
      deps
    );
    expect(result.authorized).toBe(true);
    expect(deps.recordDenial).not.toHaveBeenCalled();
  });

  it("audits a denied global operation without leaking object existence", async () => {
    const deps = dependencies(PERMISSIONS.CONFIGURATION_READ);
    const result = await authorizeSystemRequest(
      new Request("http://localhost/api/jobs/job-secret/replay", {
        method: "POST",
        headers: { "x-apm-user-id": "admin-1", "x-request-id": "request-denied" }
      }),
      PERMISSIONS.JOB_REPLAY,
      AUDIT_OBJECT_TYPES.PERSISTENT_JOB,
      "job-secret",
      deps
    );
    expect(result.authorized).toBe(false);
    if (!result.authorized) expect(result.response.status).toBe(403);
    expect(deps.recordDenial).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: PERMISSIONS.JOB_REPLAY,
        reason: "PERMISSION_NOT_GRANTED",
        objectId: "job-secret",
        path: "/api/jobs/job-secret/replay"
      })
    );
  });
});
