import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const reuseService = vi.hoisted(() => ({ correctKnowledgeReuse: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/platform-api/application/idempotent-command", () => command);
vi.mock("@/modules/knowledge/application/knowledge-reuse-service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/modules/knowledge/application/knowledge-reuse-service")
  >()),
  ...reuseService
}));

import { KnowledgeReuseServiceError } from "@/modules/knowledge/application/knowledge-reuse-service";
import { POST } from "./route";

const context = { params: Promise.resolve({ projectId: "target-project-1", reuseId: "reuse-1" }) };
const body = {
  expectedReuseVersion: 1,
  correctionType: "SCOPE_CORRECTION",
  reason: "适用范围需要明确。",
  correctionText: "仅适用于停机状态。"
};
function request(value = body) {
  return new Request(
    "http://localhost/api/projects/target-project-1/knowledge-reuse/reuse-1/corrections",
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "correction-1" },
      body: JSON.stringify(value)
    }
  );
}

describe("POST /api/projects/[projectId]/knowledge-reuse/[reuseId]/corrections", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    command.idempotentCommandResponse.mockReset();
    reuseService.correctKnowledgeReuse.mockReset();
  });

  it("binds a correction to its target project and reuse record", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });
    command.idempotentCommandResponse.mockResolvedValue(Response.json({ id: "correction-1" }));

    await POST(request(), context);

    expect(command.idempotentCommandResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "manager-1",
        operation: "projects.knowledge-reuse.correct"
      })
    );
  });

  it("does not invoke correction when target scope or active membership is denied", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });

    expect((await POST(request(), context)).status).toBe(403);
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(reuseService.correctKnowledgeReuse).not.toHaveBeenCalled();
  });

  it("passes only the route target and reuse IDs to the correction service", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });
    reuseService.correctKnowledgeReuse.mockResolvedValue({ id: "correction-1" });
    command.idempotentCommandResponse.mockImplementation(async (input) => {
      const result = await input.execute({} as never);
      return Response.json(result.body, { status: result.status });
    });

    expect((await POST(request(), context)).status).toBe(200);
    expect(reuseService.correctKnowledgeReuse).toHaveBeenCalledWith(
      expect.objectContaining({
        targetProjectId: "target-project-1",
        reuseRecordId: "reuse-1",
        targetProjectAccess: true,
        auditContext: expect.objectContaining({ projectId: "target-project-1" })
      }),
      expect.anything()
    );
  });

  it("maps a target-scoped reuse-record IDOR failure to 404", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });
    reuseService.correctKnowledgeReuse.mockRejectedValue(
      new KnowledgeReuseServiceError("KNOWLEDGE_REUSE_NOT_FOUND", "知识复用记录不存在。", 404)
    );
    command.idempotentCommandResponse.mockImplementation(async (input) =>
      input.execute({} as never)
    );

    expect((await POST(request(), context)).status).toBe(404);
  });
});
