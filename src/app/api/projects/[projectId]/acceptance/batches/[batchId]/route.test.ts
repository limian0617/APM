import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const acceptanceService = vi.hoisted(() => ({ getAcceptanceBatch: vi.fn() }));
const authorization = vi.hoisted(() => ({ decideAuthorization: vi.fn() }));
vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/acceptance/application/acceptance-service", () => acceptanceService);
vi.mock("@/lib/auth/authorize", () => authorization);

import { GET } from "./route";

describe("GET acceptance batch detail", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    acceptanceService.getAcceptanceBatch.mockReset();
    authorization.decideAuthorization.mockReset();
  });

  it("requires acceptance read permission", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });
    const response = await GET(
      new Request("http://localhost/api/projects/p-1/acceptance/batches/b-1"),
      { params: Promise.resolve({ projectId: "p-1", batchId: "b-1" }) }
    );
    expect(response.status).toBe(403);
    expect(acceptanceService.getAcceptanceBatch).not.toHaveBeenCalled();
  });

  it("reads only the project-scoped batch", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "u-1" },
      project: { departmentId: "engineering", memberRoles: ["QUALITY"] }
    });
    authorization.decideAuthorization
      .mockReturnValueOnce({ allowed: true })
      .mockReturnValueOnce({ allowed: true })
      .mockReturnValueOnce({ allowed: true })
      .mockReturnValueOnce({ allowed: true });
    acceptanceService.getAcceptanceBatch.mockResolvedValue({ batch: { id: "b-1" }, summary: {} });
    const response = await GET(
      new Request("http://localhost/api/projects/p-1/acceptance/batches/b-1"),
      { params: Promise.resolve({ projectId: "p-1", batchId: "b-1" }) }
    );
    expect(response.status).toBe(200);
    expect(acceptanceService.getAcceptanceBatch).toHaveBeenCalledWith("p-1", "b-1", [
      "CREATE_BATCH",
      "LOCK_BATCH",
      "START_BATCH",
      "RECORD_RESULT",
      "REVISE_RESULT",
      "CREATE_FAILURE_ISSUE",
      "LINK_FAILURE_ISSUE"
    ]);
  });
});
