import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const service = vi.hoisted(() => {
  class UphRetestServiceError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: 403 | 404 | 409 | 422
    ) {
      super(message);
      this.name = "UphRetestServiceError";
    }
  }

  return {
    UphRetestServiceError,
    createUphRetest: vi.fn(),
    listUphRetests: vi.fn()
  };
});

vi.mock("@/lib/auth/project-guard", () => guard);
vi.mock("@/modules/platform-api/application/idempotent-command", () => command);
vi.mock("@/modules/uph/application/uph-retest-service", () => service);

import { GET, POST } from "./route";

const actor = {
  id: "retest-actor",
  name: "UPH engineer",
  status: "ACTIVE",
  departmentId: "engineering",
  systemRoles: [],
  grants: []
};
const project = { id: "project-1", departmentId: "engineering", memberRoles: ["ENGINEER"] };
const path = { projectId: "project-1", issueId: "issue-1" };
const body = {
  issueVersion: 1,
  batchNumber: "RETEST-1",
  plannedProductionSeconds: 3600,
  planDeclarationReason: "new observation",
  observationStartedAt: "2026-09-02T00:00:00Z",
  observationEndedAt: null,
  timezone: "Asia/Shanghai",
  reason: "repeat test"
};
const transaction = { transaction: "retest-transaction" };

function context(overrides: Partial<typeof path> = {}) {
  return { params: Promise.resolve({ ...path, ...overrides }) };
}

function request(
  method: "GET" | "POST",
  payload: unknown = body,
  options: { key?: string | null; ifMatch?: string } = {}
) {
  const headers = new Headers({ "x-user-id": actor.id });
  if (method === "POST") {
    headers.set("content-type", "application/json");
    if (options.key !== null) headers.set("idempotency-key", options.key ?? "retest-key");
    if (options.ifMatch) headers.set("if-match", options.ifMatch);
  }
  return new Request("http://localhost", {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(payload) } : {})
  });
}

function serviceError(code: string, status: 403 | 404 | 409 | 422) {
  return new service.UphRetestServiceError(code, code, status);
}

describe("APM-084 UPH retest Route Handler", () => {
  beforeEach(() => {
    guard.authorizeProjectRequest
      .mockReset()
      .mockResolvedValue({ authorized: true, actor, project });
    command.idempotentCommandResponse.mockReset().mockImplementation(async (input) => {
      const result = await input.execute(transaction);
      return Response.json(result.body, { status: result.status });
    });
    service.createUphRetest.mockReset().mockResolvedValue({ batchId: "retest-batch" });
    service.listUphRetests.mockReset().mockResolvedValue({ items: [] });
  });

  it("denies before parsing a forged retest body", async () => {
    guard.authorizeProjectRequest.mockResolvedValueOnce({
      authorized: false,
      response: Response.json({ error: { code: "PROJECT_NOT_FOUND" } }, { status: 404 })
    });
    const response = await POST(request("POST", { topologyRootNodeId: "forged" }), context());
    expect(response.status).toBe(404);
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(service.createUphRetest).not.toHaveBeenCalled();
  });

  it("requires If-Match and Idempotency-Key and keeps topology server-owned", async () => {
    const missingIfMatch = await POST(request("POST", body), context());
    expect(missingIfMatch.status).toBe(409);
    const missingKey = await POST(request("POST", body, { key: null, ifMatch: "1" }), context());
    expect(missingKey.status).toBe(400);
    const forged = await POST(
      request("POST", { ...body, topologyRootNodeId: "forged" }, { ifMatch: "1" }),
      context()
    );
    expect(forged.status).toBe(422);
    expect(service.createUphRetest).not.toHaveBeenCalled();
  });

  it("uses batch-manage permission and forwards the issue version to one transaction", async () => {
    const response = await POST(request("POST", body, { ifMatch: "1" }), context());
    expect(response.status).toBe(201);
    expect(guard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      path.projectId,
      "PROJECT_UPH_BATCH_MANAGE",
      { requireProjectMembership: true }
    );
    expect(service.createUphRetest).toHaveBeenCalledWith(
      expect.objectContaining({ ...path, issueVersion: 1, actorId: actor.id }),
      transaction
    );
  });

  it("lists with issue-read permission and maps stable IDOR/conflict errors", async () => {
    const response = await GET(request("GET"), context());
    expect(response.status).toBe(200);
    expect(guard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      path.projectId,
      "PROJECT_ISSUE_READ",
      { requireProjectMembership: true }
    );
    service.createUphRetest.mockRejectedValueOnce(serviceError("UPH_SOURCE_BATCH_REQUIRED", 409));
    const conflict = await POST(request("POST", body, { ifMatch: "1" }), context());
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "UPH_SOURCE_BATCH_REQUIRED" }
    });
  });
});
