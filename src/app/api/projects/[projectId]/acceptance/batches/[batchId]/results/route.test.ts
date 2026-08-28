import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const acceptanceService = vi.hoisted(() => ({ recordAcceptanceResultRevision: vi.fn() }));
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

import { POST } from "./route";

describe("POST acceptance result revision", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    acceptanceService.recordAcceptanceResultRevision.mockReset();
  });

  it("writes an append-only result revision through the project command permission", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "u-1" },
      project: { departmentId: "quality" }
    });
    acceptanceService.recordAcceptanceResultRevision.mockResolvedValue({
      revision: { id: "rev-1" }
    });
    const response = await POST(
      new Request("http://localhost/api/projects/p-1/acceptance/batches/b-1/results", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-1" },
        body: JSON.stringify({
          version: 1,
          itemId: "item-1",
          decision: "PASS",
          measuredValue: "230V"
        })
      }),
      { params: Promise.resolve({ projectId: "p-1", batchId: "b-1" }) }
    );
    expect(response.status).toBe(201);
    expect(acceptanceService.recordAcceptanceResultRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p-1",
        batchId: "b-1",
        itemId: "item-1",
        actorId: "u-1"
      }),
      undefined
    );
  });

  it("requires evidence-management permission before accepting an evidence file reference", async () => {
    projectGuard.authorizeProjectRequest
      .mockResolvedValueOnce({
        authorized: true,
        actor: { id: "u-1" },
        project: { departmentId: "quality" }
      })
      .mockResolvedValueOnce({
        authorized: false,
        response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
      });
    const response = await POST(
      new Request("http://localhost/api/projects/p-1/acceptance/batches/b-1/results", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-2" },
        body: JSON.stringify({
          version: 1,
          itemId: "item-1",
          decision: "PASS",
          evidenceFileIds: ["file-1"]
        })
      }),
      { params: Promise.resolve({ projectId: "p-1", batchId: "b-1" }) }
    );
    expect(response.status).toBe(403);
    expect(projectGuard.authorizeProjectRequest).toHaveBeenLastCalledWith(
      expect.any(Request),
      "p-1",
      "ACCEPTANCE_EVIDENCE_MANAGE"
    );
    expect(acceptanceService.recordAcceptanceResultRevision).not.toHaveBeenCalled();
  });
});
