import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const service = vi.hoisted(() => {
  class UphAnalysisServiceError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: 403 | 404 | 409 | 422
    ) {
      super(message);
      this.name = "UphAnalysisServiceError";
    }
  }

  return {
    UphAnalysisServiceError,
    createUphAnalysis: vi.fn(),
    listUphAnalyses: vi.fn()
  };
});

vi.mock("@/lib/auth/project-guard", () => guard);
vi.mock("@/modules/platform-api/application/idempotent-command", () => command);
vi.mock("@/modules/uph/application/uph-analysis-service", () => service);

import { GET, POST } from "./route";

const actor = {
  id: "analysis-actor",
  name: "UPH analyst",
  status: "ACTIVE",
  departmentId: "engineering",
  systemRoles: [],
  grants: []
};
const project = {
  id: "project-1",
  departmentId: "engineering",
  memberRoles: ["ENGINEER"]
};
const path = { projectId: "project-1", batchId: "batch-1", revisionId: "revision-1" };
const transaction = { transaction: "route-idempotency-transaction" };

function context(overrides: Partial<typeof path> = {}) {
  return { params: Promise.resolve({ ...path, ...overrides }) };
}

function request(
  method: "GET" | "POST",
  options: {
    body?: unknown;
    headers?: Record<string, string>;
    query?: string;
    idempotencyKey?: string | null;
  } = {}
) {
  const headers = new Headers({ "x-user-id": actor.id, ...options.headers });
  if (method === "POST") {
    headers.set("content-type", "application/json");
    if (options.idempotencyKey !== null) {
      headers.set("idempotency-key", options.idempotencyKey ?? "analysis-command-key");
    }
  }
  return new Request(
    `http://localhost/api/projects/${path.projectId}/uph/test-batches/${path.batchId}/revisions/${path.revisionId}/analyses${options.query ?? ""}`,
    {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {})
    }
  );
}

function analysisError(
  code: string,
  status: 403 | 404 | 409 | 422
): InstanceType<typeof service.UphAnalysisServiceError> {
  return new service.UphAnalysisServiceError(code, `analysis ${code}`, status);
}

describe("APM-082 UPH analysis collection Route Handler", () => {
  beforeEach(() => {
    guard.authorizeProjectRequest
      .mockReset()
      .mockResolvedValue({ authorized: true, actor, project });
    command.idempotentCommandResponse.mockReset().mockImplementation(async (input) => {
      const result = await input.execute(transaction);
      return Response.json(result.body, { status: result.status });
    });
    service.createUphAnalysis.mockReset().mockResolvedValue({ analysisId: "analysis-1" });
    service.listUphAnalyses.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  });

  it("returns a POST guard denial before parsing a forged body or touching idempotency", async () => {
    guard.authorizeProjectRequest.mockResolvedValueOnce({
      authorized: false,
      response: Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 })
    });

    const response = await POST(request("POST", { body: { forged: true } }), context());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(service.createUphAnalysis).not.toHaveBeenCalled();
  });

  it("returns a list guard denial before parsing an invalid query", async () => {
    guard.authorizeProjectRequest.mockResolvedValueOnce({
      authorized: false,
      response: Response.json({ error: { code: "PROJECT_NOT_FOUND" } }, { status: 404 })
    });

    const response = await GET(
      request("GET", { query: "?analysisId=forged&unknown=true" }),
      context()
    );

    expect(response.status).toBe(404);
    expect(service.listUphAnalyses).not.toHaveBeenCalled();
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
  });

  it("strictly accepts the empty create command body and rejects client-derived fields", async () => {
    const accepted = await POST(request("POST", { body: {} }), context());
    expect(accepted.status).toBe(201);

    const rejected = await POST(
      request("POST", { body: { engineCode: "client-derived", formulaVersionId: "forged" } }),
      context()
    );
    expect(rejected.status).toBe(422);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(service.createUphAnalysis).toHaveBeenCalledTimes(1);
  });

  it("requires a valid idempotency key but never requires If-Match", async () => {
    const missingKey = await POST(request("POST", { idempotencyKey: null }), context());
    expect(missingKey.status).toBe(400);
    await expect(missingKey.json()).resolves.toMatchObject({ error: { code: "INVALID_HEADERS" } });
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();

    const created = await POST(request("POST", { body: {} }), context());
    expect(created.status).toBe(201);
    expect(service.createUphAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ ...path, actorId: actor.id }),
      transaction
    );
  });

  it("uses the analyze permission, trusted guard facts, exact fingerprint, and one executor transaction", async () => {
    const response = await POST(request("POST", { body: {} }), context());

    expect(response.status).toBe(201);
    expect(guard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      path.projectId,
      "PROJECT_UPH_ANALYZE",
      { requireProjectMembership: true }
    );
    expect(command.idempotentCommandResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: actor.id,
        operation: "projects.uph.analysis.create",
        idempotencyKey: "analysis-command-key",
        request: { path, body: {} }
      })
    );
    expect(service.createUphAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        ...path,
        actorId: actor.id,
        authorizationActor: actor,
        projectMemberRoles: project.memberRoles,
        auditContext: expect.objectContaining({ actorId: actor.id, projectId: path.projectId })
      }),
      transaction
    );
  });

  it("lists with read permission and no idempotency executor even when no key is provided", async () => {
    const response = await GET(request("GET", { query: "?cursor=cursor-1&limit=2" }), context());

    expect(response.status).toBe(200);
    expect(guard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      path.projectId,
      "PROJECT_UPH_READ",
      { requireProjectMembership: true }
    );
    expect(service.listUphAnalyses).toHaveBeenCalledWith(
      expect.objectContaining({
        ...path,
        cursor: "cursor-1",
        limit: 2,
        actorId: actor.id,
        authorizationActor: actor,
        projectMemberRoles: project.memberRoles
      })
    );
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
  });

  it.each(["?analysisId=forged", "?unknown=true", "?limit=0", "?limit=101"])(
    "rejects the strict collection query %s before the list service",
    async (query) => {
      const response = await GET(request("GET", { query }), context());
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_QUERY" } });
      expect(service.listUphAnalyses).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["AUTHORIZATION_DENIED", 403],
    ["ANALYSIS_NOT_FOUND", 404],
    ["LOCKED_REVISION_REQUIRED", 409],
    ["ANALYSIS_CONFLICT", 409],
    ["ANALYSIS_INPUT_INVALID", 422],
    ["ANALYSIS_FORMULA_UNSUPPORTED", 422]
  ] as const)("maps the structured %s service error", async (code, status) => {
    service.createUphAnalysis.mockRejectedValueOnce(analysisError(code, status));

    const response = await POST(request("POST", { body: {} }), context());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
  });

  it("leaves an unknown service error to request observability", async () => {
    service.createUphAnalysis.mockRejectedValueOnce(new Error("unexpected failure"));

    const response = await POST(request("POST", { body: {} }), context());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });
});
