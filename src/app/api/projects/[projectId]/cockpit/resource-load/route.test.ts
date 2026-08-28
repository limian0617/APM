import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const resourceLoad = vi.hoisted(() => ({
  getLatestProjectResourceLoad: vi.fn(),
  getProjectResourceLoadById: vi.fn()
}));
const personAuthorization = vi.hoisted(() => ({ authorizeResourceLoadPeopleRead: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/cockpit/application/resource-load-projection-service", () => resourceLoad);
vi.mock("@/modules/cockpit/application/resource-load-authorization", () => personAuthorization);

import { GET } from "./route";

const context = { params: Promise.resolve({ projectId: "project-1" }) };
const projection = {
  projectionId: "projection-1",
  projectId: "project-1",
  sourceChecksum: "a".repeat(64),
  sourceVersions: {
    tasks: [
      {
        taskId: "task-1",
        ownerMembershipId: "member-1",
        personId: "user-1",
        personName: "Engineer"
      }
    ]
  },
  peopleCount: 1,
  departments: [
    {
      departmentId: "engineering",
      plannedDays: 3,
      activeTaskCount: 1,
      disciplines: [{ discipline: "ENGINEER", plannedDays: 3, activeTaskCount: 1, people: [] }]
    }
  ]
};

describe("GET /api/projects/[projectId]/cockpit/resource-load", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    resourceLoad.getLatestProjectResourceLoad.mockReset();
    personAuthorization.authorizeResourceLoadPeopleRead.mockReset();
  });

  it("requires project read before querying a resource-load projection", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });

    const response = await GET(
      new Request("http://localhost/api/projects/project-1/cockpit/resource-load", {
        method: "GET"
      }),
      context
    );

    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "project-1",
      "PROJECT_READ"
    );
    expect(resourceLoad.getLatestProjectResourceLoad).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it("returns department and discipline aggregates without person details or sensitive identifiers", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reader-1" },
      project: { id: "project-1", departmentId: "engineering", memberRoles: ["ENGINEER"] }
    });
    resourceLoad.getLatestProjectResourceLoad.mockResolvedValue({ status: "READY", projection });
    personAuthorization.authorizeResourceLoadPeopleRead.mockResolvedValue(false);

    const response = await GET(
      new Request("http://localhost/api/projects/project-1/cockpit/resource-load", {
        method: "GET"
      }),
      context
    );

    expect(resourceLoad.getLatestProjectResourceLoad).toHaveBeenCalledWith("project-1", false);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toMatchObject({
      status: "READY",
      peopleIncluded: false,
      projection: expect.objectContaining({ projectionId: "projection-1" })
    });
    expect(JSON.stringify(body)).not.toContain("sourceVersions");
    expect(JSON.stringify(body)).not.toContain("taskId");
    expect(JSON.stringify(body)).not.toContain("ownerMembershipId");
    expect(JSON.stringify(body)).not.toContain("personId");
    expect(JSON.stringify(body)).not.toContain("personName");
  });

  it("returns person details from the audited projection rather than a later latest snapshot", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reader-1" },
      project: { id: "project-1", departmentId: "engineering", memberRoles: ["ENGINEER"] }
    });
    const { sourceVersions: _sourceVersions, ...aggregate } = projection;
    const personal = {
      ...projection,
      departments: [
        {
          ...projection.departments[0],
          disciplines: [
            {
              ...projection.departments[0].disciplines[0],
              people: [
                { ownerMembershipId: "member-1", personId: "user-1", personName: "Engineer" }
              ]
            }
          ]
        }
      ]
    };
    resourceLoad.getLatestProjectResourceLoad.mockResolvedValue({
      status: "READY",
      projection: aggregate
    });
    resourceLoad.getProjectResourceLoadById.mockResolvedValue(personal);
    personAuthorization.authorizeResourceLoadPeopleRead.mockResolvedValue(true);

    const response = await GET(
      new Request("http://localhost/api/projects/project-1/cockpit/resource-load", {
        method: "GET"
      }),
      context
    );

    expect(personAuthorization.authorizeResourceLoadPeopleRead).toHaveBeenCalledWith(
      expect.objectContaining({ projectionId: "projection-1", peopleCount: 1 })
    );
    expect(resourceLoad.getLatestProjectResourceLoad).toHaveBeenCalledOnce();
    expect(resourceLoad.getProjectResourceLoadById).toHaveBeenCalledWith(
      "project-1",
      "projection-1",
      true
    );
    await expect(response.json()).resolves.toEqual({
      status: "READY",
      peopleIncluded: true,
      projection: personal
    });
  });
});
