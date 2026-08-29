import { beforeEach, describe, expect, it, vi } from "vitest";

const systemGuard = vi.hoisted(() => ({ authorizeSystemRequest: vi.fn() }));
const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const authorizationQuery = vi.hoisted(() => ({ resolveKnowledgeVersionSourceProject: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const revokeService = vi.hoisted(() => ({ revokeKnowledgeEntryVersion: vi.fn() }));

vi.mock("@/lib/auth/system-guard", () => systemGuard);
vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock(
  "@/modules/knowledge/application/knowledge-authorization-query",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/modules/knowledge/application/knowledge-authorization-query")
    >()),
    ...authorizationQuery
  })
);
vi.mock("@/modules/platform-api/application/idempotent-command", () => command);
vi.mock("@/modules/knowledge/application/knowledge-entry-service", () => revokeService);

import { POST } from "./route";
import { KnowledgeAuthorizationQueryError } from "@/modules/knowledge/application/knowledge-authorization-query";

const context = { params: Promise.resolve({ entryId: "entry-1" }) };
const body = { versionId: "version-1", expectedEntryVersion: 2, reason: "发现过期的安全前提。" };
function request(value: unknown) {
  return new Request("http://localhost/api/knowledge/entry-1/revoke", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "revoke-1" },
    body: JSON.stringify(value)
  });
}

describe("POST /api/knowledge/[entryId]/revoke", () => {
  beforeEach(() => {
    systemGuard.authorizeSystemRequest.mockReset();
    projectGuard.authorizeProjectRequest.mockReset();
    authorizationQuery.resolveKnowledgeVersionSourceProject.mockReset();
    command.idempotentCommandResponse.mockReset();
    revokeService.revokeKnowledgeEntryVersion.mockReset();
  });

  it("denies globally before source lookup", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });

    expect((await POST(request(body), context)).status).toBe(403);
    expect(authorizationQuery.resolveKnowledgeVersionSourceProject).not.toHaveBeenCalled();
  });

  it("rejects a forged source field before lookup, guard, or command", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reviewer-1" }
    });

    expect(
      (await POST(request({ ...body, sourceProjectId: "forged-project" }), context)).status
    ).toBe(400);
    expect(authorizationQuery.resolveKnowledgeVersionSourceProject).not.toHaveBeenCalled();
    expect(projectGuard.authorizeProjectRequest).not.toHaveBeenCalled();
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(revokeService.revokeKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it("maps every unknown command field to 400 before source lookup", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reviewer-1" }
    });

    expect((await POST(request({ ...body, untracked: true }), context)).status).toBe(400);
    expect(authorizationQuery.resolveKnowledgeVersionSourceProject).not.toHaveBeenCalled();
    expect(projectGuard.authorizeProjectRequest).not.toHaveBeenCalled();
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(revokeService.revokeKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it("uses the exact entry/version pair to find the real source and stops on its denial", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reviewer-1" }
    });
    authorizationQuery.resolveKnowledgeVersionSourceProject.mockResolvedValue({
      sourceProjectId: "actual-source"
    });
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });

    expect((await POST(request(body), context)).status).toBe(403);
    expect(authorizationQuery.resolveKnowledgeVersionSourceProject).toHaveBeenCalledWith(
      {
        entryId: "entry-1",
        versionId: "version-1"
      },
      expect.anything()
    );
    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "actual-source",
      "PROJECT_RETROSPECTIVE_READ"
    );
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
  });

  it("returns 404 for a version that is not part of the route entry without source authorization", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reviewer-1" }
    });
    authorizationQuery.resolveKnowledgeVersionSourceProject.mockRejectedValue(
      new KnowledgeAuthorizationQueryError("KNOWLEDGE_VERSION_NOT_FOUND", "知识版本不存在。")
    );

    expect((await POST(request(body), context)).status).toBe(404);
    expect(projectGuard.authorizeProjectRequest).not.toHaveBeenCalled();
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(revokeService.revokeKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it("revokes after real-source authorization and gives the service only server-derived source access", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reviewer-1" }
    });
    authorizationQuery.resolveKnowledgeVersionSourceProject.mockResolvedValue({
      sourceProjectId: "actual-source"
    });
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reviewer-1" },
      project: { departmentId: "quality" }
    });
    revokeService.revokeKnowledgeEntryVersion.mockResolvedValue({ status: "REVOKED" });
    command.idempotentCommandResponse.mockImplementation(async (input) => {
      const result = await input.execute({} as never);
      return Response.json(result.body, { status: result.status });
    });

    expect((await POST(request(body), context)).status).toBe(200);
    expect(revokeService.revokeKnowledgeEntryVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: "entry-1",
        versionId: "version-1",
        sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: true },
        auditContext: expect.objectContaining({
          projectId: "actual-source",
          departmentId: "quality"
        })
      }),
      expect.anything()
    );
  });
});
