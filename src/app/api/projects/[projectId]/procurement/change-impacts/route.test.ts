import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const changeImpactService = vi.hoisted(() => ({ listProcurementChangeImpacts: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/procurement/application/change-impact-service", () => changeImpactService);

import { GET } from "./route";

describe("GET /api/projects/[projectId]/procurement/change-impacts", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    changeImpactService.listProcurementChangeImpacts.mockReset();
  });

  it("uses procurement read authorization and returns only the current project's impacts", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });
    changeImpactService.listProcurementChangeImpacts.mockResolvedValue({
      projectId: "project-1",
      impacts: [{ id: "impact-1", projectId: "project-1", status: "OPEN", obligations: [] }]
    });

    const response = await GET(
      new Request("http://localhost/api/projects/project-1/procurement/change-impacts?status=OPEN"),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );

    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "project-1",
      "PROJECT_PROCUREMENT_READ"
    );
    expect(changeImpactService.listProcurementChangeImpacts).toHaveBeenCalledWith({
      projectId: "project-1",
      status: "OPEN",
      limit: 100
    });
    await expect(response.json()).resolves.toMatchObject({
      projectId: "project-1",
      impacts: [{ id: "impact-1", projectId: "project-1" }]
    });
  });
});
