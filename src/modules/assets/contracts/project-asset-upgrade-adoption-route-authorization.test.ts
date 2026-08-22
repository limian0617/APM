import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const service = vi.hoisted(() => ({
  adoptProjectAssetUpgrade: vi.fn(),
  recordAssetUpgradeAdoptionFailure: vi.fn()
}));
const idempotency = vi.hoisted(() => ({
  idempotentCommandResponse: vi.fn(
    async (input: { execute: (tx: unknown) => Promise<{ status: number; body: unknown }> }) => {
      const result = await input.execute({});
      return Response.json(result.body, { status: result.status });
    }
  )
}));

vi.mock("@/lib/auth/project-guard", () => guard);
vi.mock("@/modules/assets/application/asset-upgrade-adoption-service", () => service);
vi.mock("@/modules/platform-api/application/idempotent-command", () => idempotency);

import { POST } from "@/app/api/projects/[projectId]/asset-upgrade-adoptions/route";

const actor = {
  id: "manager-1",
  name: "Manager",
  status: "ACTIVE" as const,
  departmentId: "engineering",
  systemRoles: ["PROJECT_MANAGER"],
  grants: [
    { permission: "PROJECT_ASSET_USAGE_MANAGE", scope: "PROJECT", systemRole: "PROJECT_MANAGER" },
    { permission: "TECHNICAL_ASSET_READ", scope: "PROJECT", systemRole: "PROJECT_MANAGER" }
  ]
};

function request(body: unknown, ifMatch = "2") {
  return new Request("http://localhost/api/projects/project-1/asset-upgrade-adoptions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-apm-user-id": actor.id,
      "idempotency-key": "adoption-command-1",
      "if-match": ifMatch
    },
    body: JSON.stringify(body)
  });
}

const body = {
  candidateId: "candidate-1",
  impactId: "impact-1",
  impactVersion: 4,
  sourceReferenceId: "source-reference-1",
  sourceReferenceVersion: 2,
  reason: "adopt exact upgrade",
  mappings: []
};

describe("APM-064 project asset upgrade adoption route", () => {
  beforeEach(() => {
    guard.authorizeProjectRequest.mockReset().mockResolvedValue({
      authorized: true,
      actor,
      project: { id: "project-1", departmentId: "engineering" }
    });
    service.adoptProjectAssetUpgrade.mockReset().mockResolvedValue({ item: { id: "adoption-1" } });
    service.recordAssetUpgradeAdoptionFailure.mockReset().mockResolvedValue(undefined);
    idempotency.idempotentCommandResponse.mockClear();
  });

  it("requires project membership, manage and technical asset read before idempotency", async () => {
    guard.authorizeProjectRequest
      .mockResolvedValueOnce({ authorized: true, actor, project: { id: "project-1" } })
      .mockResolvedValueOnce({
        authorized: false,
        response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
      });
    const response = await POST(request(body), {
      params: Promise.resolve({ projectId: "project-1" })
    });
    expect(response.status).toBe(403);
    expect(service.adoptProjectAssetUpgrade).not.toHaveBeenCalled();
    expect(idempotency.idempotentCommandResponse).not.toHaveBeenCalled();
  });

  it("passes exact operation, If-Match source reference version and actor to service", async () => {
    const response = await POST(request(body), {
      params: Promise.resolve({ projectId: "project-1" })
    });
    expect(response.status).toBe(201);
    expect(guard.authorizeProjectRequest).toHaveBeenNthCalledWith(
      1,
      expect.any(Request),
      "project-1",
      "PROJECT_ASSET_USAGE_MANAGE",
      { requireProjectMembership: true }
    );
    expect(guard.authorizeProjectRequest).toHaveBeenNthCalledWith(
      2,
      expect.any(Request),
      "project-1",
      "TECHNICAL_ASSET_READ",
      { requireProjectMembership: true }
    );
    expect(idempotency.idempotentCommandResponse).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: actor.id, operation: "projects.asset-upgrade.adopt" })
    );
    expect(service.adoptProjectAssetUpgrade).toHaveBeenCalledWith(
      expect.objectContaining({
        ...body,
        projectId: "project-1",
        actorId: actor.id,
        authorizationActor: actor
      }),
      expect.anything()
    );
  });

  it("rejects If-Match/body mismatch before idempotency", async () => {
    const response = await POST(request(body, "1"), {
      params: Promise.resolve({ projectId: "project-1" })
    });
    expect(response.status).toBe(409);
    expect(idempotency.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(service.adoptProjectAssetUpgrade).not.toHaveBeenCalled();
  });

  it("records a failure audit after a transactional service conflict", async () => {
    service.adoptProjectAssetUpgrade.mockRejectedValue(
      Object.assign(new Error("stale impact"), {
        code: "ASSET_IMPACT_VERSION_CONFLICT",
        status: 409
      })
    );
    const response = await POST(request(body), {
      params: Promise.resolve({ projectId: "project-1" })
    });
    expect(response.status).toBe(409);
    expect(service.recordAssetUpgradeAdoptionFailure).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", objectId: "project-1" })
    );
  });
});
