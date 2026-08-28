import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const service = vi.hoisted(() => ({ submitRetrospectiveVersion: vi.fn() }));
vi.mock("@/lib/auth/project-guard", () => guard);
vi.mock("@/modules/retrospectives/application/project-retrospective-service", () => service);
vi.mock("@/modules/platform-api/application/idempotent-command", () => ({
  idempotentCommandResponse: async (input: any) => {
    const result = await input.execute(undefined);
    return Response.json(result.body, { status: result.status });
  }
}));
import { POST } from "./route";

describe("retrospective submit route", () => {
  beforeEach(() => {
    guard.authorizeProjectRequest.mockReset();
    service.submitRetrospectiveVersion.mockReset();
  });
  it("requires project management permission", async () => {
    guard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });
    const response = await POST(new Request("http://localhost", { method: "POST" }), {
      params: Promise.resolve({ projectId: "p-1", versionId: "v-1" })
    });
    expect(response.status).toBe(403);
    expect(service.submitRetrospectiveVersion).not.toHaveBeenCalled();
  });
});
