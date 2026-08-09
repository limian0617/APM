import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const acceptanceService = vi.hoisted(() => ({ lockAcceptanceBatch: vi.fn() }));
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

describe("POST acceptance batch lock", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    acceptanceService.lockAcceptanceBatch.mockReset();
  });

  it("uses review permission and the optimistic version", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "u-1" },
      project: { departmentId: "quality" }
    });
    acceptanceService.lockAcceptanceBatch.mockResolvedValue({ batch: { id: "b-1" } });
    const response = await POST(
      new Request("http://localhost/api/projects/p-1/acceptance/batches/b-1/lock", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-1" },
        body: JSON.stringify({ version: 2, reason: "锁定验收记录" })
      }),
      { params: Promise.resolve({ projectId: "p-1", batchId: "b-1" }) }
    );
    expect(response.status).toBe(200);
    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "p-1",
      "ACCEPTANCE_REVIEW"
    );
    expect(acceptanceService.lockAcceptanceBatch).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-1", batchId: "b-1", version: 2 }),
      undefined
    );
  });
});
