import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeEntryServiceError } from "@/modules/knowledge/application/knowledge-entry-service";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";

const systemGuard = vi.hoisted(() => ({ authorizeSystemRequest: vi.fn() }));
const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const entryService = vi.hoisted(() => ({ createKnowledgeEntryVersion: vi.fn() }));

vi.mock("@/lib/auth/system-guard", () => systemGuard);
vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/platform-api/application/idempotent-command", () => command);
vi.mock("@/modules/knowledge/application/knowledge-entry-service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/modules/knowledge/application/knowledge-entry-service")
  >()),
  ...entryService
}));

import { POST } from "./route";

const versionBody = () => ({
  code: "KNW-001",
  sourceProjectId: "source-project-1",
  finalArchiveVersionId: "archive-b-1",
  retrospectiveInputArchiveVersionId: "archive-a-1",
  retrospectiveVersionId: "retrospective-1",
  issueHistoryIds: [],
  draft: {
    title: "安全复位",
    sanitizedSummary: "已移除来源敏感信息。",
    experienceType: "LESSON_LEARNED",
    discipline: "MECHANICAL",
    keywords: ["复位"],
    applicableProjectTypes: ["LINE"],
    applicableStageCodes: ["S4"],
    preconditions: "停机。",
    recommendedPractice: "隔离后复位。",
    antiPatterns: "不得带电操作。",
    limitations: "仅限停机状态。",
    ipSanitizationDeclaration: "已完成脱敏。",
    internalReusable: true
  },
  expectedEntryVersion: 1
});

function createRequest(body: unknown = versionBody()) {
  return new Request("http://localhost/api/knowledge/knowledge-entry-1/versions", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "create-version-1" },
    body: JSON.stringify(body)
  });
}

const context = { params: Promise.resolve({ entryId: "knowledge-entry-1" }) };

function authorizeCreate() {
  systemGuard.authorizeSystemRequest.mockResolvedValue({
    authorized: true,
    actor: { id: "author-1" }
  });
  projectGuard.authorizeProjectRequest.mockResolvedValue({
    authorized: true,
    actor: { id: "author-1" },
    project: { departmentId: "engineering" }
  });
}

describe("POST /api/knowledge/[entryId]/versions", () => {
  beforeEach(() => {
    systemGuard.authorizeSystemRequest.mockReset();
    projectGuard.authorizeProjectRequest.mockReset();
    command.idempotentCommandResponse.mockReset();
    entryService.createKnowledgeEntryVersion.mockReset();
  });

  it("requires global knowledge authority and exact source-project read before creating a version", async () => {
    authorizeCreate();
    command.idempotentCommandResponse.mockResolvedValue(
      Response.json({ entryId: "knowledge-entry-1" }, { status: 201 })
    );

    const response = await POST(createRequest(), context);

    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "source-project-1",
      "PROJECT_RETROSPECTIVE_READ"
    );
    expect(command.idempotentCommandResponse).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "author-1", operation: "knowledge.entry-version.create" })
    );
    expect(response.status).toBe(201);
  });

  it("stops at a denied global knowledge guard", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ code: "FORBIDDEN" }, { status: 403 })
    });

    expect((await POST(createRequest(), context)).status).toBe(403);
    expect(projectGuard.authorizeProjectRequest).not.toHaveBeenCalled();
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(entryService.createKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it("rejects a strict invalid body before source authorization or writes", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "author-1" }
    });

    expect(
      (await POST(createRequest({ ...versionBody(), unexpected: true }), context)).status
    ).toBe(400);
    expect(projectGuard.authorizeProjectRequest).not.toHaveBeenCalled();
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(entryService.createKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it("stops at a denied source-project read guard", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "author-1" }
    });
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ code: "FORBIDDEN" }, { status: 403 })
    });

    expect((await POST(createRequest(), context)).status).toBe(403);
    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "source-project-1",
      "PROJECT_RETROSPECTIVE_READ"
    );
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(entryService.createKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it("maps an idempotency replay conflict without invoking the version service", async () => {
    authorizeCreate();
    command.idempotentCommandResponse.mockRejectedValue(
      new ApiContractError(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency-Key 已绑定到不同的请求负载。",
        409,
        [
          {
            field: "headers.idempotencyKey",
            code: "CONFLICT",
            message: "请为不同请求使用新的幂等键。"
          }
        ]
      )
    );

    const response = await POST(createRequest(), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "IDEMPOTENCY_KEY_REUSED",
        issues: [{ field: "headers.idempotencyKey", code: "CONFLICT" }]
      }
    });
    expect(command.idempotentCommandResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "author-1",
        operation: "knowledge.entry-version.create",
        idempotencyKey: "create-version-1"
      })
    );
    expect(entryService.createKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing entry",
      new KnowledgeEntryServiceError("KNOWLEDGE_ENTRY_NOT_FOUND", "不存在。", 404),
      404
    ],
    [
      "entry version conflict",
      new KnowledgeEntryServiceError("KNOWLEDGE_ENTRY_VERSION_CONFLICT", "冲突。", 409),
      409
    ]
  ])("maps a service %s error to HTTP %i", async (_case, serviceError, status) => {
    authorizeCreate();
    entryService.createKnowledgeEntryVersion.mockRejectedValue(serviceError);
    command.idempotentCommandResponse.mockImplementation(async (input) => {
      const result = await input.execute({} as never);
      return Response.json(result.body, { status: result.status });
    });

    expect((await POST(createRequest(), context)).status).toBe(status);
  });
});
