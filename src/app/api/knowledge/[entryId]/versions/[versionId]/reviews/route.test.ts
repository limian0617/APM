import { beforeEach, describe, expect, it, vi } from "vitest";

const systemGuard = vi.hoisted(() => ({ authorizeSystemRequest: vi.fn() }));
const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const authorizationQuery = vi.hoisted(() => ({ resolveKnowledgeVersionSourceProject: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const reviewService = vi.hoisted(() => ({ reviewKnowledgeEntryVersion: vi.fn() }));

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
vi.mock("@/modules/knowledge/application/knowledge-entry-service", () => reviewService);

import { POST } from "./route";
import { KnowledgeAuthorizationQueryError } from "@/modules/knowledge/application/knowledge-authorization-query";

const context = { params: Promise.resolve({ entryId: "entry-1", versionId: "version-1" }) };
const allowed = {
  authorized: true,
  actor: { id: "reviewer-1" },
  project: { departmentId: "quality" }
};
const body = {
  expectedEntryVersion: 2,
  decision: "PUBLISH",
  reason: "已完成脱敏与知识产权检查。",
  ipConfirmed: true,
  sanitizationConfirmed: true
};
function request(value: unknown) {
  return new Request("http://localhost/api/knowledge/entry-1/versions/version-1/reviews", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "review-1" },
    body: JSON.stringify(value)
  });
}

describe("POST /api/knowledge/[entryId]/versions/[versionId]/reviews", () => {
  beforeEach(() => {
    systemGuard.authorizeSystemRequest.mockReset();
    projectGuard.authorizeProjectRequest.mockReset();
    authorizationQuery.resolveKnowledgeVersionSourceProject.mockReset();
    command.idempotentCommandResponse.mockReset();
    reviewService.reviewKnowledgeEntryVersion.mockReset();
  });

  it("denies globally before source lookup", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });

    expect((await POST(request(body), context)).status).toBe(403);
    expect(authorizationQuery.resolveKnowledgeVersionSourceProject).not.toHaveBeenCalled();
  });

  it("rejects a forged source field before lookup", async () => {
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
    expect(reviewService.reviewKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it("maps blank text and an illegal decision enum to 400 before source lookup", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reviewer-1" }
    });

    expect((await POST(request({ ...body, reason: " " }), context)).status).toBe(400);
    expect((await POST(request({ ...body, decision: "INVALID" }), context)).status).toBe(400);
    expect(authorizationQuery.resolveKnowledgeVersionSourceProject).not.toHaveBeenCalled();
    expect(projectGuard.authorizeProjectRequest).not.toHaveBeenCalled();
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
  });

  it("uses the actual source for the project guard and stops on denial", async () => {
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
    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "actual-source",
      "PROJECT_RETROSPECTIVE_READ"
    );
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(reviewService.reviewKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it("returns 404 for an entry/version mismatch without a project guard or command", async () => {
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
    expect(reviewService.reviewKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it("reviews only after actual-source authorization and sends its audit scope to the service", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reviewer-1" }
    });
    authorizationQuery.resolveKnowledgeVersionSourceProject.mockResolvedValue({
      sourceProjectId: "actual-source"
    });
    projectGuard.authorizeProjectRequest.mockResolvedValue(allowed);
    reviewService.reviewKnowledgeEntryVersion.mockResolvedValue({ status: "PUBLISHED" });
    command.idempotentCommandResponse.mockImplementation(async (input) => {
      const result = await input.execute({} as never);
      return Response.json(result.body, { status: result.status });
    });

    expect((await POST(request(body), context)).status).toBe(200);
    expect(reviewService.reviewKnowledgeEntryVersion).toHaveBeenCalledWith(
      expect.objectContaining({
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
