import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const acceptanceService = vi.hoisted(() => ({ getAcceptanceSummary: vi.fn() }));
vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/acceptance/application/acceptance-service", () => acceptanceService);

import { GET } from "./route";

describe("GET acceptance summary", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    acceptanceService.getAcceptanceSummary.mockReset();
  });

  it("returns the service summary without inventing a pass rate", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "u-1" },
      project: { departmentId: "quality" }
    });
    acceptanceService.getAcceptanceSummary.mockResolvedValue({
      projectId: "p-1",
      batchId: "b-1",
      passRate: null,
      outcome: "NOT_CALCULABLE"
    });
    const response = await GET(
      new Request("http://localhost/api/projects/p-1/acceptance/batches/b-1/summary"),
      { params: Promise.resolve({ projectId: "p-1", batchId: "b-1" }) }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ passRate: null });
  });
});
