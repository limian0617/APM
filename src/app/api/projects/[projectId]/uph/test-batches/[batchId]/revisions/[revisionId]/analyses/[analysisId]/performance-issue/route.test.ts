import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const service = vi.hoisted(() => {
  class UphPerformanceIssueServiceError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: 403 | 404 | 409 | 422
    ) {
      super(message);
      this.name = "UphPerformanceIssueServiceError";
    }
  }

  return {
    UphPerformanceIssueServiceError,
    createUphPerformanceIssue: vi.fn(),
    getUphPerformanceIssue: vi.fn()
  };
});

vi.mock("@/lib/auth/project-guard", () => guard);
vi.mock("@/modules/platform-api/application/idempotent-command", () => command);
vi.mock("@/modules/uph/application/uph-performance-issue-service", () => service);

import { GET, POST } from "./route";

const actor = {
  id: "issue-actor",
  name: "UPH engineer",
  status: "ACTIVE",
  departmentId: "engineering",
  systemRoles: [],
  grants: []
};
const project = { id: "project-1", departmentId: "engineering", memberRoles: ["ENGINEER"] };
const path = {
  projectId: "project-1",
  batchId: "batch-1",
  revisionId: "revision-1",
  analysisId: "analysis-1"
};
const body = {
  title: "UPH below target",
  confirmedText: "Actual good UPH is below target.",
  severity: "MEDIUM",
  reason: "Record locked analysis"
};
const transaction = { transaction: "issue-transaction" };

function context(overrides: Partial<typeof path> = {}) {
  return { params: Promise.resolve({ ...path, ...overrides }) };
}

function request(
  method: "GET" | "POST",
  payload: unknown = body,
  idempotencyKey: string | null = "issue-key"
) {
  const headers = new Headers({ "x-user-id": actor.id });
  if (method === "POST") {
    headers.set("content-type", "application/json");
    if (idempotencyKey !== null) headers.set("idempotency-key", idempotencyKey);
  }
  return new Request("http://localhost", {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(payload) } : {})
  });
}

function serviceError(code: string, status: 403 | 404 | 409 | 422) {
  return new service.UphPerformanceIssueServiceError(code, code, status);
}

describe("APM-084 performance issue Route Handler", () => {
  beforeEach(() => {
    guard.authorizeProjectRequest
      .mockReset()
      .mockResolvedValue({ authorized: true, actor, project });
    command.idempotentCommandResponse.mockReset().mockImplementation(async (input) => {
      const result = await input.execute(transaction);
      return Response.json(result.body, { status: result.status });
    });
    service.createUphPerformanceIssue
      .mockReset()
      .mockResolvedValue({ issue: {}, deduplicated: false });
    service.getUphPerformanceIssue
      .mockReset()
      .mockResolvedValue({ issue: {}, deduplicated: false });
  });

  it("denies before parsing a forged command", async () => {
    guard.authorizeProjectRequest.mockResolvedValueOnce({
      authorized: false,
      response: Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 })
    });
    const response = await POST(request("POST", { category: "SAFETY" }), context());
    expect(response.status).toBe(401);
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(service.createUphPerformanceIssue).not.toHaveBeenCalled();
  });

  it("uses create permission, strict DTO, and one idempotent transaction", async () => {
    const response = await POST(request("POST"), context());
    expect(response.status).toBe(201);
    expect(guard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      path.projectId,
      "PROJECT_ISSUE_CREATE",
      { requireProjectMembership: true }
    );
    expect(command.idempotentCommandResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: actor.id,
        operation: "projects.uph.performance-issue.create",
        idempotencyKey: "issue-key",
        request: { path, body }
      })
    );
    expect(service.createUphPerformanceIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        ...path,
        actorId: actor.id,
        projectMemberRoles: project.memberRoles
      }),
      transaction
    );
  });

  it("requires Idempotency-Key and rejects client-owned issue facts", async () => {
    const missing = await POST(request("POST", body, null), context());
    expect(missing.status).toBe(400);
    const forged = await POST(request("POST", { ...body, category: "SAFETY" }), context());
    expect(forged.status).toBe(422);
    expect(service.createUphPerformanceIssue).toHaveBeenCalledTimes(0);
  });

  it("uses read-only permission for GET and maps stable service conflicts", async () => {
    const response = await GET(request("GET"), context());
    expect(response.status).toBe(200);
    expect(guard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      path.projectId,
      "PROJECT_UPH_READ",
      { requireProjectMembership: true }
    );
    expect(service.getUphPerformanceIssue).toHaveBeenCalledWith(
      expect.objectContaining({ ...path, actorId: actor.id })
    );

    service.createUphPerformanceIssue.mockRejectedValueOnce(serviceError("UPH_TARGET_MET", 409));
    const conflict = await POST(request("POST"), context());
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: "UPH_TARGET_MET" } });
  });
});
