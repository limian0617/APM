import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const acceptanceService = vi.hoisted(() => ({ startAcceptanceBatch: vi.fn() }));
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

describe("POST acceptance batch start", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    acceptanceService.startAcceptanceBatch.mockReset();
  });

  it("maps a transition command to the project-scoped service", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "u-1" },
      project: { departmentId: "engineering" }
    });
    acceptanceService.startAcceptanceBatch.mockResolvedValue({ batch: { id: "b-1" } });
    const response = await POST(
      new Request("http://localhost/api/projects/p-1/acceptance/batches/b-1/start", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-1" },
        body: JSON.stringify({ version: 1, reason: "开始现场验收" })
      }),
      { params: Promise.resolve({ projectId: "p-1", batchId: "b-1" }) }
    );
    expect(response.status).toBe(200);
    expect(acceptanceService.startAcceptanceBatch).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-1", batchId: "b-1", actorId: "u-1", version: 1 }),
      undefined
    );
  });
});
