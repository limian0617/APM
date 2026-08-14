import { beforeEach, describe, expect, it, vi } from "vitest";

const systemGuard = vi.hoisted(() => ({ authorizeSystemRequest: vi.fn() }));
const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const authorizationQuery = vi.hoisted(() => ({ resolveKnowledgeVersionSourceProject: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const submitService = vi.hoisted(() => ({ submitKnowledgeEntryVersion: vi.fn() }));

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
vi.mock("@/modules/knowledge/application/knowledge-entry-service", () => submitService);

import { POST } from "./route";
import { KnowledgeAuthorizationQueryError } from "@/modules/knowledge/application/knowledge-authorization-query";

const context = { params: Promise.resolve({ entryId: "entry-1", versionId: "version-1" }) };
const sourceAllowed = {
  authorized: true,
  actor: { id: "author-1" },
  project: { departmentId: "engineering" }
};

function request(body: unknown) {
  return new Request("http://localhost/api/knowledge/entry-1/versions/version-1/submit", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "submit-1" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/knowledge/[entryId]/versions/[versionId]/submit", () => {
  beforeEach(() => {
    systemGuard.authorizeSystemRequest.mockReset();
    projectGuard.authorizeProjectRequest.mockReset();
    authorizationQuery.resolveKnowledgeVersionSourceProject.mockReset();
    command.idempotentCommandResponse.mockReset();
    submitService.submitKnowledgeEntryVersion.mockReset();
  });

  it("denies globally before looking up the version", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });

    const response = await POST(request({ expectedEntryVersion: 2 }), context);

    expect(response.status).toBe(403);
    expect(authorizationQuery.resolveKnowledgeVersionSourceProject).not.toHaveBeenCalled();
    expect(projectGuard.authorizeProjectRequest).not.toHaveBeenCalled();
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(submitService.submitKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it("rejects a forged source project field before lookup or command execution", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "author-1" }
    });

    const response = await POST(
      request({ expectedEntryVersion: 2, sourceProjectId: "forged-project" }),
      context
    );

    expect(response.status).toBe(400);
    expect(authorizationQuery.resolveKnowledgeVersionSourceProject).not.toHaveBeenCalled();
    expect(projectGuard.authorizeProjectRequest).not.toHaveBeenCalled();
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(submitService.submitKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it("maps every unknown command field to 400 before source lookup", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "author-1" }
    });

    expect(
      (await POST(request({ expectedEntryVersion: 2, untracked: true }), context)).status
    ).toBe(400);
    expect(authorizationQuery.resolveKnowledgeVersionSourceProject).not.toHaveBeenCalled();
    expect(projectGuard.authorizeProjectRequest).not.toHaveBeenCalled();
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(submitService.submitKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it("maps an invalid route path to 400 before source lookup", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "author-1" }
    });

    const response = await POST(request({ expectedEntryVersion: 2 }), {
      params: Promise.resolve({ entryId: " ", versionId: "version-1" })
    });

    expect(response.status).toBe(400);
    expect(authorizationQuery.resolveKnowledgeVersionSourceProject).not.toHaveBeenCalled();
    expect(projectGuard.authorizeProjectRequest).not.toHaveBeenCalled();
  });

  it("uses only the resolved real source project and stops on its denial", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "author-1" }
    });
    authorizationQuery.resolveKnowledgeVersionSourceProject.mockResolvedValue({
      sourceProjectId: "actual-source-project"
    });
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });

    const response = await POST(request({ expectedEntryVersion: 2 }), context);

    expect(response.status).toBe(403);
    expect(authorizationQuery.resolveKnowledgeVersionSourceProject).toHaveBeenCalledWith(
      {
        entryId: "entry-1",
        versionId: "version-1"
      },
      expect.anything()
    );
    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "actual-source-project",
      "PROJECT_RETROSPECTIVE_READ"
    );
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(submitService.submitKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it("returns 404 for an entry/version mismatch without revealing or guarding a source project", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "author-1" }
    });
    authorizationQuery.resolveKnowledgeVersionSourceProject.mockRejectedValue(
      new KnowledgeAuthorizationQueryError("KNOWLEDGE_VERSION_NOT_FOUND", "知识版本不存在。")
    );

    expect((await POST(request({ expectedEntryVersion: 2 }), context)).status).toBe(404);
    expect(projectGuard.authorizeProjectRequest).not.toHaveBeenCalled();
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(submitService.submitKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it("submits only after real-source authorization and uses it for audit context", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "author-1" }
    });
    authorizationQuery.resolveKnowledgeVersionSourceProject.mockResolvedValue({
      sourceProjectId: "actual-source-project"
    });
    projectGuard.authorizeProjectRequest.mockResolvedValue(sourceAllowed);
    submitService.submitKnowledgeEntryVersion.mockResolvedValue({ status: "IN_REVIEW" });
    command.idempotentCommandResponse.mockImplementation(async (input) => {
      const result = await input.execute({} as never);
      return Response.json(result.body, { status: result.status });
    });

    const response = await POST(request({ expectedEntryVersion: 2 }), context);

    expect(response.status).toBe(200);
    expect(submitService.submitKnowledgeEntryVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: "entry-1",
        versionId: "version-1",
        expectedEntryVersion: 2,
        sourceRead: { knowledgePermissionAllowed: true, sourceProjectReadAllowed: true },
        auditContext: expect.objectContaining({
          projectId: "actual-source-project",
          departmentId: "engineering"
        })
      }),
      expect.anything()
    );
  });
});
