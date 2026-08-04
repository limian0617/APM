import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const projectionService = vi.hoisted(() => ({ getLatestCockpitProjection: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/cockpit/application/cockpit-projection-service", () => projectionService);

import { GET } from "./route";

describe("GET /api/projects/[projectId]/cockpit", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    projectionService.getLatestCockpitProjection.mockReset();
  });

  it("requires project read permission before querying a projection", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });

    const response = await GET(
      new Request("http://localhost/api/projects/project-1/cockpit", { method: "GET" }),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );

    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "project-1",
      "PROJECT_READ"
    );
    expect(projectionService.getLatestCockpitProjection).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it("returns the explicit unavailable state when the project has no snapshot", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });
    projectionService.getLatestCockpitProjection.mockResolvedValue({
      status: "NOT_AVAILABLE",
      projection: null
    });

    const response = await GET(
      new Request("http://localhost/api/projects/project-1/cockpit", { method: "GET" }),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "NOT_AVAILABLE", projection: null });
  });
});
