import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeEntryServiceError } from "@/modules/knowledge/application/knowledge-entry-service";
import { KnowledgeSearchCapabilityError } from "@/modules/knowledge/application/knowledge-search-capability";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";

const systemGuard = vi.hoisted(() => ({ authorizeSystemRequest: vi.fn() }));
const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const entryService = vi.hoisted(() => ({ createKnowledgeEntryVersion: vi.fn() }));
const searchService = vi.hoisted(() => ({ searchPublishedKnowledge: vi.fn() }));
const pageContextQuery = vi.hoisted(() => ({ resolveKnowledgeReusePageContext: vi.fn() }));

vi.mock("@/lib/auth/system-guard", () => systemGuard);
vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/platform-api/application/idempotent-command", () => command);
vi.mock("@/modules/knowledge/application/knowledge-entry-service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/modules/knowledge/application/knowledge-entry-service")
  >()),
  ...entryService
}));
vi.mock("@/modules/knowledge/application/knowledge-search-service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/modules/knowledge/application/knowledge-search-service")
  >()),
  ...searchService
}));
vi.mock(
  "@/modules/knowledge/application/knowledge-authorization-query",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/modules/knowledge/application/knowledge-authorization-query")
    >()),
    ...pageContextQuery
  })
);

import { GET, POST } from "./route";

const createBody = () => ({
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
  expectedEntryVersion: null
});

function createRequest(body: unknown = createBody()) {
  return new Request("http://localhost/api/knowledge", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "create-knowledge-1" },
    body: JSON.stringify(body)
  });
}

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

describe("GET /api/knowledge", () => {
  beforeEach(() => {
    systemGuard.authorizeSystemRequest.mockReset();
    projectGuard.authorizeProjectRequest.mockReset();
    command.idempotentCommandResponse.mockReset();
    entryService.createKnowledgeEntryVersion.mockReset();
    searchService.searchPublishedKnowledge.mockReset();
    pageContextQuery.resolveKnowledgeReusePageContext.mockReset();
  });

  it("authorizes knowledge search and returns a source-sanitized public DTO", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: {
        id: "reader-1",
        status: "ACTIVE",
        systemRoles: ["role-quality"],
        grants: [{ permission: "KNOWLEDGE_REVIEW", scope: "ALL", systemRole: "role-quality" }]
      }
    });
    searchService.searchPublishedKnowledge.mockResolvedValue({
      capability: "DEGRADED",
      warningCode: "SEARCH_DEGRADED",
      nextCursor: null,
      pageState: { status: "NORMAL", allowedActions: ["CREATE"], reuseContext: null },
      items: [
        {
          entryCode: "KNW-001",
          version: 1,
          title: "安全复位",
          sanitizedSummary: "已移除来源敏感信息。",
          experienceType: "LESSON_LEARNED",
          discipline: "MECHANICAL",
          keywords: ["复位"],
          applicableProjectTypes: ["LINE"],
          applicableStageCodes: ["S4"],
          status: "PUBLISHED",
          sourceProjectId: "must-not-leak",
          issueId: "must-not-leak"
        }
      ]
    });

    const response = await GET(
      new Request("http://localhost/api/knowledge?query=%E5%A4%8D%E4%BD%8D")
    );

    expect(systemGuard.authorizeSystemRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "KNOWLEDGE_READ",
      "KNOWLEDGE_ENTRY",
      null
    );
    expect(searchService.searchPublishedKnowledge).toHaveBeenCalledWith(
      { query: "复位", page: 1, pageSize: 20 },
      expect.objectContaining({
        getCapability: expect.any(Function),
        repository: expect.any(Object)
      })
    );
    const responseBody = await response.json();
    expect(responseBody).toEqual({
      capability: "DEGRADED",
      warningCode: "SEARCH_DEGRADED",
      nextCursor: null,
      pageState: { status: "NORMAL", allowedActions: ["CREATE"], reuseContext: null },
      items: [
        {
          entryCode: "KNW-001",
          version: 1,
          title: "安全复位",
          sanitizedSummary: "已移除来源敏感信息。",
          experienceType: "LESSON_LEARNED",
          discipline: "MECHANICAL",
          keywords: ["复位"],
          applicableProjectTypes: ["LINE"],
          applicableStageCodes: ["S4"],
          status: "PUBLISHED"
        }
      ]
    });
    expect(responseBody.items[0]).not.toHaveProperty("entryId");
    expect(responseBody.items[0]).not.toHaveProperty("versionId");
  });

  it("maps an unavailable search capability to HTTP 503", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reader-1" }
    });
    searchService.searchPublishedKnowledge.mockRejectedValue(
      new KnowledgeSearchCapabilityError(
        "KNOWLEDGE_SEARCH_CAPABILITY_UNAVAILABLE",
        "无法确认知识检索数据库能力。"
      )
    );

    expect(
      (await GET(new Request("http://localhost/api/knowledge?query=%E5%A4%8D%E4%BD%8D"))).status
    ).toBe(503);
  });

  it("returns initial server page-state without issuing a synthetic knowledge search", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: {
        id: "reader-1",
        status: "ACTIVE",
        systemRoles: ["role-quality"],
        grants: [{ permission: "KNOWLEDGE_REVIEW", scope: "ALL", systemRole: "role-quality" }]
      }
    });

    const response = await GET(new Request("http://localhost/api/knowledge?view=PAGE_STATE"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      pageState: { status: "EMPTY", allowedActions: ["CREATE"], reuseContext: null },
      items: []
    });
    expect(searchService.searchPublishedKnowledge).not.toHaveBeenCalled();
  });

  it("derives reuse and correction actions only from a globally authorized exact target-project context", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: {
        id: "reader-1",
        status: "ACTIVE",
        systemRoles: ["role-admin"],
        grants: [{ permission: "KNOWLEDGE_REVIEW", scope: "ALL", systemRole: "role-admin" }]
      }
    });
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reader-1" },
      project: { departmentId: "engineering" }
    });
    pageContextQuery.resolveKnowledgeReusePageContext.mockResolvedValue({
      canCorrectReuse: true,
      reuseContext: { reuseId: "reuse-1", version: 1 }
    });
    searchService.searchPublishedKnowledge.mockResolvedValue({
      capability: "TRIGRAM",
      warningCode: null,
      nextCursor: null,
      items: [
        {
          entryCode: "KNW-001",
          version: 1,
          title: "安全复位",
          sanitizedSummary: "已移除来源敏感信息。",
          experienceType: "LESSON_LEARNED",
          discipline: "MECHANICAL",
          keywords: ["复位"],
          applicableProjectTypes: ["LINE"],
          applicableStageCodes: ["S4"],
          status: "PUBLISHED"
        }
      ]
    });

    const response = await GET(
      new Request(
        "http://localhost/api/knowledge?query=%E5%A4%8D%E4%BD%8D&targetProjectId=target-project-1&reuseId=reuse-1"
      )
    );

    expect(response.status).toBe(200);
    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "target-project-1",
      "KNOWLEDGE_REUSE_CONFIRM"
    );
    expect(pageContextQuery.resolveKnowledgeReusePageContext).toHaveBeenCalledWith(
      { targetProjectId: "target-project-1", reuseId: "reuse-1" },
      expect.any(Object)
    );
    await expect(response.json()).resolves.toMatchObject({
      pageState: {
        status: "NORMAL",
        allowedActions: ["CREATE", "CONFIRM_REUSE", "CORRECT_REUSE"],
        reuseContext: { reuseId: "reuse-1", version: 1 }
      }
    });
  });

  it("keeps global knowledge readable after target-project reuse authorization is denied", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reader-1" }
    });
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });

    searchService.searchPublishedKnowledge.mockResolvedValue({
      capability: "TRIGRAM",
      warningCode: null,
      nextCursor: null,
      items: []
    });
    const response = await GET(
      new Request(
        "http://localhost/api/knowledge?query=%E5%A4%8D%E4%BD%8D&targetProjectId=target-project-1"
      )
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pageState: { status: "EMPTY", allowedActions: [], reuseContext: null }
    });
    expect(searchService.searchPublishedKnowledge).toHaveBeenCalledOnce();
    expect(pageContextQuery.resolveKnowledgeReusePageContext).not.toHaveBeenCalled();
  });

  it.each(["CLOSED", "CANCELED"])(
    "removes target-project reuse actions when the shared write policy marks %s read-only",
    async (status) => {
      systemGuard.authorizeSystemRequest.mockResolvedValue({
        authorized: true,
        actor: { id: "reader-1" }
      });
      projectGuard.authorizeProjectRequest.mockResolvedValue({
        authorized: true,
        actor: { id: "reader-1" },
        project: { departmentId: "engineering", status }
      });
      pageContextQuery.resolveKnowledgeReusePageContext.mockResolvedValue({
        canCorrectReuse: true,
        reuseContext: { reuseId: "reuse-1", version: 1 }
      });
      searchService.searchPublishedKnowledge.mockResolvedValue({
        capability: "TRIGRAM",
        warningCode: null,
        nextCursor: null,
        items: [
          {
            entryCode: "KNW-001",
            version: 1,
            title: "安全复位",
            sanitizedSummary: "已移除来源敏感信息。",
            experienceType: "LESSON_LEARNED",
            discipline: "MECHANICAL",
            keywords: ["复位"],
            applicableProjectTypes: ["LINE"],
            applicableStageCodes: ["S4"],
            status: "PUBLISHED"
          }
        ]
      });

      const response = await GET(
        new Request(
          "http://localhost/api/knowledge?query=%E5%A4%8D%E4%BD%8D&targetProjectId=target-project-1&reuseId=reuse-1"
        )
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        pageState: { status: "NORMAL", allowedActions: [], reuseContext: null }
      });
      expect(pageContextQuery.resolveKnowledgeReusePageContext).not.toHaveBeenCalled();
    }
  );

  it("keeps global knowledge readable and removes target actions when target authorization is denied", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reader-1" }
    });
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });
    searchService.searchPublishedKnowledge.mockResolvedValue({
      capability: "TRIGRAM",
      warningCode: null,
      nextCursor: null,
      items: [
        {
          entryCode: "KNW-001",
          version: 1,
          title: "安全复位",
          sanitizedSummary: "已移除来源敏感信息。",
          experienceType: "LESSON_LEARNED",
          discipline: "MECHANICAL",
          keywords: ["复位"],
          applicableProjectTypes: ["LINE"],
          applicableStageCodes: ["S4"],
          status: "PUBLISHED"
        }
      ]
    });

    const response = await GET(
      new Request(
        "http://localhost/api/knowledge?query=%E5%A4%8D%E4%BD%8D&targetProjectId=other-project"
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pageState: { status: "NORMAL", allowedActions: [], reuseContext: null }
    });
    expect(pageContextQuery.resolveKnowledgeReusePageContext).not.toHaveBeenCalled();
  });
});

describe("POST /api/knowledge", () => {
  beforeEach(() => {
    systemGuard.authorizeSystemRequest.mockReset();
    projectGuard.authorizeProjectRequest.mockReset();
    command.idempotentCommandResponse.mockReset();
    entryService.createKnowledgeEntryVersion.mockReset();
  });

  it("stops at a denied global knowledge guard", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ code: "FORBIDDEN" }, { status: 403 })
    });

    expect((await POST(createRequest())).status).toBe(403);
    expect(projectGuard.authorizeProjectRequest).not.toHaveBeenCalled();
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(entryService.createKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it("rejects a strict invalid body before source authorization or writes", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "author-1" }
    });

    expect((await POST(createRequest({ ...createBody(), unexpected: true }))).status).toBe(400);
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

    expect((await POST(createRequest())).status).toBe(403);
    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "source-project-1",
      "PROJECT_RETROSPECTIVE_READ"
    );
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(entryService.createKnowledgeEntryVersion).not.toHaveBeenCalled();
  });

  it("maps an idempotency replay conflict without invoking the create service", async () => {
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

    const response = await POST(createRequest());

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
        operation: "knowledge.entry.create",
        idempotencyKey: "create-knowledge-1"
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

    expect((await POST(createRequest())).status).toBe(status);
  });
});
