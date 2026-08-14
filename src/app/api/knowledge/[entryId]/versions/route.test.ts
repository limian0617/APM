import { beforeEach, describe, expect, it, vi } from "vitest";

const systemGuard = vi.hoisted(() => ({ authorizeSystemRequest: vi.fn() }));
const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const entryService = vi.hoisted(() => ({ createKnowledgeEntryVersion: vi.fn() }));

vi.mock("@/lib/auth/system-guard", () => systemGuard);
vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/platform-api/application/idempotent-command", () => command);
vi.mock("@/modules/knowledge/application/knowledge-entry-service", () => entryService);

import { POST } from "./route";

describe("POST /api/knowledge/[entryId]/versions", () => {
  beforeEach(() => {
    systemGuard.authorizeSystemRequest.mockReset();
    projectGuard.authorizeProjectRequest.mockReset();
    command.idempotentCommandResponse.mockReset();
    entryService.createKnowledgeEntryVersion.mockReset();
  });

  it("requires global knowledge authority and exact source-project read before creating a version", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "author-1" }
    });
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "author-1" },
      project: { departmentId: "engineering" }
    });
    command.idempotentCommandResponse.mockResolvedValue(
      Response.json({ entryId: "knowledge-entry-1" }, { status: 201 })
    );

    const response = await POST(
      new Request("http://localhost/api/knowledge/knowledge-entry-1/versions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "create-version-1" },
        body: JSON.stringify({
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
        })
      }),
      { params: Promise.resolve({ entryId: "knowledge-entry-1" }) }
    );

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
});
