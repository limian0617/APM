import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const query = vi.hoisted(() => ({
  getProjectRetrospective: vi.fn(),
  ProjectRetrospectiveQueryError: class ProjectRetrospectiveQueryError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
}));
const service = vi.hoisted(() => ({
  createRetrospectiveVersion: vi.fn(),
  ProjectRetrospectiveServiceError: class ProjectRetrospectiveServiceError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message = code
    ) {
      super(message);
    }
  }
}));
const decide = vi.hoisted(() => ({ decideAuthorization: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => guard);
vi.mock("@/lib/auth/authorize", () => decide);
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
    decide.decideAuthorization.mockReset();
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

  it("maps a successful GET to exact pointers and never exposes close before G9 approval", async () => {
    guard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "u-1" },
      project: { departmentId: "engineering", memberRoles: ["PROJECT_MANAGER"] }
    });
    decide.decideAuthorization.mockReturnValue({ allowed: true });
    query.getProjectRetrospective.mockResolvedValue({
      projectId: "p-1",
      retrospective: { id: "retro-1" },
      currentVersionId: "retro-version-1",
      latestApprovedVersionId: "retro-version-1",
      currentVersion: { id: "retro-version-1", status: "APPROVED" },
      latestApprovedVersion: { id: "retro-version-1", status: "APPROVED" },
      archiveA: {
        id: "archive-a",
        status: "READY",
        manifestChecksum: "archive-a-manifest",
        sourceWatermark: "archive-a-source",
        retrospectiveInputWatermark: "archive-a-input"
      },
      archiveB: {
        id: "archive-b",
        status: "READY",
        manifestChecksum: "archive-b-manifest",
        sourceWatermark: "archive-b-source",
        retrospectiveInputWatermark: "archive-b-input"
      },
      closurePolicy: { id: "policy-v2", status: "ACTIVE" },
      g9Approval: null,
      versions: [{ id: "retro-version-1", status: "APPROVED" }],
      reviews: [],
      allowedActions: []
    });

    const response = await GET(new Request("http://localhost/api/projects/p-1/retrospectives"), {
      params: Promise.resolve({ projectId: "p-1" })
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "NORMAL",
      archiveA: {
        id: "archive-a",
        manifestChecksum: "archive-a-manifest",
        sourceWatermark: "archive-a-source",
        retrospectiveInputWatermark: "archive-a-input"
      },
      archiveB: {
        id: "archive-b",
        manifestChecksum: "archive-b-manifest",
        sourceWatermark: "archive-b-source",
        retrospectiveInputWatermark: "archive-b-input"
      },
      currentVersionId: "retro-version-1",
      latestApprovedVersionId: "retro-version-1"
    });
    expect(body.allowedActions).toContain("RUN_G9");
    expect(body.allowedActions).not.toContain("CLOSE_PROJECT");
  });

  it("maps an EMPTY GET to the exact Archive A and only CREATE", async () => {
    guard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "u-1" },
      project: { departmentId: "engineering", memberRoles: ["PROJECT_MANAGER"] }
    });
    decide.decideAuthorization.mockReturnValue({ allowed: true });
    query.getProjectRetrospective.mockResolvedValue({
      projectId: "p-1",
      retrospective: null,
      currentVersionId: null,
      latestApprovedVersionId: null,
      currentVersion: null,
      latestApprovedVersion: null,
      archiveA: { id: "archive-a", status: "READY" },
      archiveB: null,
      closurePolicy: null,
      g9Approval: null,
      versions: [],
      reviews: [],
      allowedActions: []
    });

    const response = await GET(new Request("http://localhost/api/projects/p-1/retrospectives"), {
      params: Promise.resolve({ projectId: "p-1" })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "EMPTY", archiveA: { id: "archive-a" } });
    expect(body.allowedActions).toEqual(["CREATE"]);
  });

  it("maps a stale GET without exposing Archive B or G9 actions", async () => {
    guard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "u-1" },
      project: { departmentId: "engineering", memberRoles: ["PROJECT_MANAGER"] }
    });
    decide.decideAuthorization.mockReturnValue({ allowed: true });
    query.getProjectRetrospective.mockResolvedValue({
      projectId: "p-1",
      retrospective: { id: "retro-1" },
      currentVersionId: "retro-draft",
      latestApprovedVersionId: "retro-approved",
      currentVersion: { id: "retro-draft", status: "DRAFT" },
      latestApprovedVersion: { id: "retro-approved", status: "APPROVED" },
      archiveA: { id: "archive-a", status: "READY" },
      archiveB: { id: "archive-b", status: "READY" },
      closurePolicy: { id: "policy-v2", status: "ACTIVE" },
      g9Approval: { submissionId: "g9-submission", status: "APPROVED" },
      versions: [],
      reviews: [],
      allowedActions: []
    });

    const response = await GET(new Request("http://localhost/api/projects/p-1/retrospectives"), {
      params: Promise.resolve({ projectId: "p-1" })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("STALE");
    expect(body.allowedActions).toContain("SUBMIT");
    expect(body.allowedActions).not.toContain("RUN_G9");
    expect(body.allowedActions).not.toContain("CLOSE_PROJECT");
  });

  it("maps query pointer errors to a conflict response", async () => {
    guard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "u-1" },
      project: { departmentId: "engineering", memberRoles: ["PROJECT_MANAGER"] }
    });
    query.getProjectRetrospective.mockRejectedValue(
      new (query.ProjectRetrospectiveQueryError as any)("PROJECT_RETROSPECTIVE_POINTER_INVALID")
    );

    const response = await GET(new Request("http://localhost/api/projects/p-1/retrospectives"), {
      params: Promise.resolve({ projectId: "p-1" })
    });
    expect(response.status).toBe(409);
  });
});
