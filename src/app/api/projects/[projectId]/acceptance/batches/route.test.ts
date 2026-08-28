import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const acceptanceService = vi.hoisted(() => ({
  createAcceptanceBatch: vi.fn(),
  listAcceptanceBatches: vi.fn()
}));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/acceptance/application/acceptance-service", () => acceptanceService);
vi.mock("@/modules/platform-api/application/idempotent-command", () => ({
  idempotentCommandResponse: async (input: {
    execute: (transaction: unknown) => Promise<{ status: number; body: unknown }>;
  }) => {
    const result = await input.execute(undefined);
    return Response.json(result.body, { status: result.status });
  }
}));

import { GET, POST } from "./route";

describe("acceptance batch routes", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    acceptanceService.createAcceptanceBatch.mockReset();
    acceptanceService.listAcceptanceBatches.mockReset();
  });

  it("denies reads before querying project batches", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });

    const response = await GET(
      new Request("http://localhost/api/projects/p-1/acceptance/batches"),
      { params: Promise.resolve({ projectId: "p-1" }) }
    );

    expect(response.status).toBe(403);
    expect(acceptanceService.listAcceptanceBatches).not.toHaveBeenCalled();
  });

  it("passes only the current project and parsed DTO to the service", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "u-1" },
      project: { departmentId: "engineering" }
    });
    acceptanceService.createAcceptanceBatch.mockResolvedValue({ batch: { id: "b-1" } });

    const response = await POST(
      new Request("http://localhost/api/projects/p-1/acceptance/batches", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-1" },
        body: JSON.stringify({
          acceptanceType: "FAT",
          scopeType: "PROJECT",
          scopeId: "p-1",
          templateVersionId: "tv-1",
          version: 0
        })
      }),
      { params: Promise.resolve({ projectId: "p-1" }) }
    );

    expect(response.status).toBe(201);
    expect(acceptanceService.createAcceptanceBatch).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-1", actorId: "u-1", scopeId: "p-1" }),
      undefined
    );
  });
});
