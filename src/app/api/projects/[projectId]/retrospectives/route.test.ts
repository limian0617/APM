import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const query = vi.hoisted(() => ({ getProjectRetrospective: vi.fn() }));
const service = vi.hoisted(() => ({ createRetrospectiveVersion: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => guard);
vi.mock("@/modules/retrospectives/application/project-retrospective-query-service", () => query);
vi.mock("@/modules/retrospectives/application/project-retrospective-service", () => service);
vi.mock("@/modules/platform-api/application/idempotent-command", () => ({
  idempotentCommandResponse: async (input: any) => {
    const result = await input.execute(undefined);
    return Response.json(result.body, { status: result.status });
  }
}));

import { GET, POST } from "./route";

describe("project retrospective route", () => {
  beforeEach(() => {
    guard.authorizeProjectRequest.mockReset();
    query.getProjectRetrospective.mockReset();
    service.createRetrospectiveVersion.mockReset();
  });

  it("denies before reading retrospective", async () => {
    guard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });
    const response = await GET(new Request("http://localhost/api/projects/p-1/retrospectives"), {
      params: Promise.resolve({ projectId: "p-1" })
    });
    expect(response.status).toBe(403);
    expect(query.getProjectRetrospective).not.toHaveBeenCalled();
  });

  it("passes only strict server-scoped create data", async () => {
    guard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "u-1" },
      project: { departmentId: "engineering", memberRoles: ["PROJECT_MANAGER"] }
    });
    service.createRetrospectiveVersion.mockResolvedValue({ id: "rv-1", status: "DRAFT" });
    const response = await POST(
      new Request("http://localhost/api/projects/p-1/retrospectives", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "retro-1" },
        body: JSON.stringify({
          archiveVersionId: "archive-a",
          expectedAggregateVersion: null,
          content: {
            deliverySummary: {},
            successfulPractices: {},
            shortcomings: {},
            improvements: {},
            knowledgeDisposition: {},
            ipDeclaration: {}
          },
          contributions: [],
          participantMembershipIds: [],
          issueHistoryIds: []
        })
      }),
      { params: Promise.resolve({ projectId: "p-1" }) }
    );
    expect(response.status).toBe(201);
    expect(service.createRetrospectiveVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p-1",
        actorId: "u-1",
        retrospectiveInputArchiveVersionId: "archive-a"
      }),
      undefined
    );
  });
});
