import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const service = vi.hoisted(() => ({ createIssueCapture: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => guard);
vi.mock("@/modules/platform-api/application/idempotent-command", () => command);
vi.mock("@/modules/issues/application/issue-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/issues/application/issue-service")>()),
  ...service
}));

import { POST } from "./route";

const context = { params: Promise.resolve({ projectId: "project-1" }) };
const actor = {
  id: "user-1",
  name: "现场工程师",
  status: "ACTIVE",
  departmentId: "department-1",
  systemRoles: ["ENGINEER"],
  grants: []
};

function request(body: unknown) {
  return new Request("http://localhost/api/projects/project-1/issue-captures", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "capture-command-1",
      "x-user-id": "user-1"
    },
    body: JSON.stringify(body)
  });
}

describe("APM-072 issue capture route", () => {
  beforeEach(() => {
    guard.authorizeProjectRequest.mockReset().mockResolvedValue({
      authorized: true,
      actor,
      project: {
        id: "project-1",
        departmentId: "department-1",
        memberRoles: ["ENGINEER"]
      }
    });
    command.idempotentCommandResponse.mockReset().mockImplementation(async (input) => {
      const result = await input.execute({} as never);
      return Response.json(result.body, { status: result.status });
    });
    service.createIssueCapture.mockReset().mockResolvedValue({ capture: { id: "capture-1" } });
  });

  it("accepts voice without formal text and passes exact actor file context", async () => {
    const response = await POST(
      request({ voiceFileId: "voice-1", mediaFileIds: ["photo-1"] }),
      context
    );

    expect(response.status).toBe(201);
    expect(guard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "project-1",
      "PROJECT_ISSUE_CREATE"
    );
    expect(command.idempotentCommandResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "user-1",
        operation: "projects.issue-capture.create"
      })
    );
    expect(service.createIssueCapture.mock.calls[0]?.[0]).toMatchObject({
      projectId: "project-1",
      voiceFileId: "voice-1",
      mediaFileIds: ["photo-1"],
      actorId: "user-1",
      fileAccess: { actor, projectDepartmentId: "department-1", memberRoles: ["ENGINEER"] }
    });
  });

  it("rejects media-only and AI transcript payloads before idempotency", async () => {
    expect((await POST(request({ mediaFileIds: ["photo-1"] }), context)).status).toBe(422);
    expect(
      (await POST(request({ voiceFileId: "voice-1", asrTranscript: "模型文本" }), context)).status
    ).toBe(422);
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(service.createIssueCapture).not.toHaveBeenCalled();
  });

  it("default-denies a missing project membership before parsing or idempotency", async () => {
    guard.authorizeProjectRequest.mockResolvedValueOnce({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });

    expect((await POST(request({ inputText: "现场文字" }), context)).status).toBe(403);
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(service.createIssueCapture).not.toHaveBeenCalled();
  });
});
