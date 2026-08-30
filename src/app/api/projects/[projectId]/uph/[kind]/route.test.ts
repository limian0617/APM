import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const service = vi.hoisted(() => ({
  createUphDefinition: vi.fn(),
  getUphDefinition: vi.fn()
}));

vi.mock("@/lib/auth/project-guard", () => guard);
vi.mock("@/modules/platform-api/application/idempotent-command", () => command);
vi.mock("@/modules/uph/application/uph-definition-service", () => service);

import { GET, PATCH, POST } from "./route";

const context = { params: Promise.resolve({ projectId: "project-1", kind: "CT" }) };
const actor = {
  id: "user-1",
  name: "工艺工程师",
  status: "ACTIVE",
  departmentId: "department-1",
  systemRoles: ["ENGINEER"],
  grants: []
};
const body = {
  kind: "CT",
  projectVersion: 1,
  content: {
    projectModuleId: "module-1",
    intrinsicCtSeconds: 12,
    outputPerCycleTotal: 4,
    parallelChannelCount: 2,
    cavityCount: 1
  }
};

function request(
  method: "GET" | "POST" | "PATCH",
  value: unknown = body,
  headers: Record<string, string> = {}
) {
  return new Request("http://localhost/api/projects/project-1/uph/CT", {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "uph-command-1",
      "x-user-id": "user-1",
      ...headers
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(value) })
  });
}

describe("APM-080 UPH definition route", () => {
  beforeEach(() => {
    guard.authorizeProjectRequest.mockReset().mockResolvedValue({
      authorized: true,
      actor,
      project: { id: "project-1", departmentId: "department-1", memberRoles: ["ENGINEER"] }
    });
    command.idempotentCommandResponse.mockReset().mockImplementation(async (input) => {
      const result = await input.execute({} as never);
      return Response.json(result.body, { status: result.status });
    });
    service.createUphDefinition.mockReset().mockResolvedValue({ id: "version-1", status: "DRAFT" });
    service.getUphDefinition.mockReset().mockResolvedValue({ id: "version-1", status: "DRAFT" });
  });

  it("default-denies an unauthenticated project request", async () => {
    guard.authorizeProjectRequest.mockResolvedValueOnce({
      authorized: false,
      response: Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 })
    });

    expect((await POST(request("POST"), context)).status).toBe(401);
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
  });

  it("rejects unknown fields with the strict DTO contract", async () => {
    const response = await POST(request("POST", { ...body, unexpected: true }), context);

    expect(response.status).toBe(422);
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(service.createUphDefinition).not.toHaveBeenCalled();
  });

  it.each(["POST", "PATCH"] as const)(
    "rejects a %s body whose kind does not match the URL kind",
    async (method) => {
      const formulaBody = {
        kind: "FORMULA",
        projectVersion: 1,
        ...(method === "PATCH" ? { versionId: "version-1", resourceVersion: 1 } : {}),
        content: { formulaCode: "CANONICAL_UPH_V1", formulaJson: {} }
      };

      const response = await (method === "POST" ? POST : PATCH)(
        request(method, formulaBody, method === "PATCH" ? { "if-match": "1" } : {}),
        context
      );

      expect(response.status).toBe(422);
      expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
      expect(service.createUphDefinition).not.toHaveBeenCalled();
    }
  );

  it("maps an If-Match/body mismatch to the stable 409 contract", async () => {
    const patchBody = { ...body, versionId: "version-1", resourceVersion: 2 };
    const response = await PATCH(request("PATCH", patchBody, { "if-match": "1" }), context);

    expect(response.status).toBe(409);
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(service.createUphDefinition).not.toHaveBeenCalled();
  });

  it("delegates an authorized create through the existing idempotency contract", async () => {
    const response = await POST(request("POST"), context);

    expect(response.status).toBe(201);
    expect(command.idempotentCommandResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "user-1",
        operation: "projects.uph.definition.create",
        idempotencyKey: "uph-command-1"
      })
    );
    expect(service.createUphDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", actorId: "user-1", body }),
      expect.anything()
    );
  });

  it("reads only a server-selected project-scoped version", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/projects/project-1/uph/CT?selection=currentWork&projectModuleId=module-1",
        {
          headers: { "x-user-id": "user-1" }
        }
      ),
      context
    );

    expect(response.status).toBe(200);
    expect(service.getUphDefinition).toHaveBeenCalledWith({
      projectId: "project-1",
      kind: "CT",
      selection: "currentWork",
      projectModuleId: "module-1",
      authorizationActor: actor,
      projectMemberRoles: ["ENGINEER"]
    });
  });

  it("requires CT current queries to carry the exact module scope", async () => {
    const response = await GET(
      new Request("http://localhost/api/projects/project-1/uph/CT?selection=currentWork", {
        headers: { "x-user-id": "user-1" }
      }),
      context
    );
    expect(response.status).toBe(400);
    expect(service.getUphDefinition).not.toHaveBeenCalled();
  });

  it.each(["TOPOLOGY", "FORMULA"] as const)(
    "reads %s current work without a CT module scope",
    async (kind) => {
      const response = await GET(
        new Request(`http://localhost/api/projects/project-1/uph/${kind}?selection=currentWork`, {
          headers: { "x-user-id": "user-1" }
        }),
        { params: Promise.resolve({ projectId: "project-1", kind }) }
      );
      expect(response.status).toBe(200);
      expect(service.getUphDefinition).toHaveBeenCalledWith({
        projectId: "project-1",
        kind,
        selection: "currentWork",
        authorizationActor: actor,
        projectMemberRoles: ["ENGINEER"]
      });
    }
  );

  it.each(["TOPOLOGY", "FORMULA"] as const)(
    "reads %s current published without a CT module scope",
    async (kind) => {
      const response = await GET(
        new Request(
          `http://localhost/api/projects/project-1/uph/${kind}?selection=currentPublished`,
          { headers: { "x-user-id": "user-1" } }
        ),
        { params: Promise.resolve({ projectId: "project-1", kind }) }
      );
      expect(response.status).toBe(200);
      expect(service.getUphDefinition).toHaveBeenCalledWith({
        projectId: "project-1",
        kind,
        selection: "currentPublished",
        authorizationActor: actor,
        projectMemberRoles: ["ENGINEER"]
      });
    }
  );

  it.each(["TOPOLOGY", "FORMULA"] as const)(
    "does not accept CT-only module scope on %s queries",
    async (kind) => {
      const response = await GET(
        new Request(
          `http://localhost/api/projects/project-1/uph/${kind}?selection=currentWork&projectModuleId=module-1`,
          {
            headers: { "x-user-id": "user-1" }
          }
        ),
        { params: Promise.resolve({ projectId: "project-1", kind }) }
      );
      expect(response.status).toBe(400);
      expect(service.getUphDefinition).not.toHaveBeenCalled();
    }
  );
});
