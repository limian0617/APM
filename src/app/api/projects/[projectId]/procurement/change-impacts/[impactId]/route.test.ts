import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const changeImpactService = vi.hoisted(() => ({ readProcurementChangeImpactDetail: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/procurement/application/change-impact-service", () => changeImpactService);

import { GET } from "./route";

describe("GET /api/projects/[projectId]/procurement/change-impacts/[impactId]", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    changeImpactService.readProcurementChangeImpactDetail.mockReset();
  });

  it("uses procurement read authorization and keeps the impact lookup in the current project", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });
    changeImpactService.readProcurementChangeImpactDetail.mockResolvedValue({
      id: "impact-1",
      projectId: "project-1",
      status: "OPEN",
      obligations: []
    });

    const response = await GET(
      new Request("http://localhost/api/projects/project-1/procurement/change-impacts/impact-1"),
      { params: Promise.resolve({ projectId: "project-1", impactId: "impact-1" }) }
    );

    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "project-1",
      "PROJECT_PROCUREMENT_READ"
    );
    expect(changeImpactService.readProcurementChangeImpactDetail).toHaveBeenCalledWith({
      projectId: "project-1",
      impactId: "impact-1"
    });
    await expect(response.json()).resolves.toMatchObject({
      id: "impact-1",
      projectId: "project-1",
      status: "OPEN"
    });
  });

  it("maps an impact from another project to a non-leaking not-found response", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });
    changeImpactService.readProcurementChangeImpactDetail.mockRejectedValue({
      code: "PROC_CHANGE_IMPACT_NOT_FOUND",
      message: "采购变更影响不存在或不属于当前项目。",
      status: 404
    });

    const response = await GET(
      new Request(
        "http://localhost/api/projects/project-1/procurement/change-impacts/impact-from-project-2"
      ),
      {
        params: Promise.resolve({
          projectId: "project-1",
          impactId: "impact-from-project-2"
        })
      }
    );

    expect(changeImpactService.readProcurementChangeImpactDetail).toHaveBeenCalledWith({
      projectId: "project-1",
      impactId: "impact-from-project-2"
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PROC_CHANGE_IMPACT_NOT_FOUND" }
    });
  });
});
