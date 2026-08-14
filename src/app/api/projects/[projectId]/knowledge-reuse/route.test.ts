import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const reuseService = vi.hoisted(() => ({ confirmKnowledgeReuse: vi.fn() }));

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

const context = { params: Promise.resolve({ projectId: "target-project-1" }) };
const body = {
  targetDeliveryUnitId: "delivery-unit-1",
  knowledgeEntryId: "entry-1",
  knowledgeVersionId: "version-1",
  scenario: "新产线复位。",
  evidenceSummary: "现场记录已归档。"
};
function request(value: unknown = body) {
  return new Request("http://localhost/api/projects/target-project-1/knowledge-reuse", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "reuse-1" },
    body: JSON.stringify(value)
  });
}

describe("POST /api/projects/[projectId]/knowledge-reuse", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    command.idempotentCommandResponse.mockReset();
    reuseService.confirmKnowledgeReuse.mockReset();
  });

  it("uses target-project scope and a distinct reuse idempotency operation", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });
    command.idempotentCommandResponse.mockResolvedValue(
      Response.json({ id: "reuse-1" }, { status: 201 })
    );

    const response = await POST(request(), context);

    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "target-project-1",
      "KNOWLEDGE_REUSE_CONFIRM"
    );
    expect(command.idempotentCommandResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "manager-1",
        operation: "projects.knowledge-reuse.confirm"
      })
    );
    expect(response.status).toBe(201);
  });

  it("does not invoke an IDOR-sensitive command when target authorization is denied", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });

    expect((await POST(request(), context)).status).toBe(403);
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(reuseService.confirmKnowledgeReuse).not.toHaveBeenCalled();
  });

  it("rejects an invalid target-project path before any command or service call", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });

    expect((await POST(request(), { params: Promise.resolve({ projectId: " " }) })).status).toBe(
      400
    );
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(reuseService.confirmKnowledgeReuse).not.toHaveBeenCalled();
  });

  it("rejects a strict invalid reuse body before any command or service call", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });

    expect((await POST(request({ ...body, unexpected: true }), context)).status).toBe(400);
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(reuseService.confirmKnowledgeReuse).not.toHaveBeenCalled();
  });

  it("passes the path target, membership-gated access, and delivery unit to the reuse service", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });
    reuseService.confirmKnowledgeReuse.mockResolvedValue({ id: "reuse-1" });
    command.idempotentCommandResponse.mockImplementation(async (input) => {
      const result = await input.execute({} as never);
      return Response.json(result.body, { status: result.status });
    });

    expect((await POST(request(), context)).status).toBe(201);
    expect(reuseService.confirmKnowledgeReuse).toHaveBeenCalledWith(
      expect.objectContaining({
        targetProjectId: "target-project-1",
        targetDeliveryUnitId: "delivery-unit-1",
        targetProjectAccess: true,
        auditContext: expect.objectContaining({ projectId: "target-project-1" })
      }),
      expect.anything()
    );
  });

  it("maps a target-scoped reuse IDOR failure without exposing another project record", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });
    reuseService.confirmKnowledgeReuse.mockRejectedValue(
      new KnowledgeReuseServiceError(
        "KNOWLEDGE_REUSE_DELIVERY_UNIT_NOT_IN_TARGET_PROJECT",
        "交付单元必须属于目标项目。",
        409
      )
    );
    command.idempotentCommandResponse.mockImplementation(async (input) =>
      input.execute({} as never)
    );

    expect((await POST(request(), context)).status).toBe(409);
  });
});
