import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const service = vi.hoisted(() => ({ createProjectIssue: vi.fn() }));

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
const body = {
  title: "工位卡滞",
  confirmedText: "用户确认：定位销卡滞。",
  category: "FUNCTION",
  severity: "HIGH",
  phenomenonDescription: null,
  rootCauseCategory: null,
  rootCauseDescription: null,
  tags: [],
  captureId: "capture-1",
  captureVersion: 1
};

function request(value: unknown = body, ifMatch: string | null = "1") {
  const headers = new Headers({
    "content-type": "application/json",
    "idempotency-key": "issue-command-1",
    "x-user-id": "user-1"
  });
  if (ifMatch !== null) headers.set("if-match", ifMatch);
  return new Request("http://localhost/api/projects/project-1/issues", {
    method: "POST",
    headers,
    body: JSON.stringify(value)
  });
}

describe("APM-072 formal issue confirmation route", () => {
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
    service.createProjectIssue.mockReset().mockResolvedValue({ issue: { id: "issue-1" } });
  });

  it("requires matching If-Match and passes the exact capture plus file authorization context", async () => {
    const response = await POST(request(), context);

    expect(response.status).toBe(201);
    expect(service.createProjectIssue.mock.calls[0]?.[0]).toMatchObject({
      projectId: "project-1",
      captureId: "capture-1",
      captureVersion: 1,
      confirmedText: "用户确认：定位销卡滞。",
      actorId: "user-1",
      captureFileAccess: {
        actor,
        projectDepartmentId: "department-1",
        memberRoles: ["ENGINEER"]
      }
    });
  });

  it("rejects stale capture versions and voice-only formal submissions before idempotency", async () => {
    expect((await POST(request(body, "2"), context)).status).toBe(409);
    expect(
      (
        await POST(
          request({
            title: "工位卡滞",
            voiceFileId: "voice-1",
            category: "FUNCTION",
            severity: "HIGH",
            phenomenonDescription: null,
            rootCauseCategory: null,
            rootCauseDescription: null,
            tags: []
          }),
          context
        )
      ).status
    ).toBe(422);
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(service.createProjectIssue).not.toHaveBeenCalled();
  });

  it("requires a valid matching If-Match and default-denies an unauthorized project", async () => {
    expect((await POST(request(body, null), context)).status).toBe(409);
    expect((await POST(request(body, "not-a-version"), context)).status).toBe(409);
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();

    guard.authorizeProjectRequest.mockResolvedValueOnce({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });
    expect((await POST(request(), context)).status).toBe(403);
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(service.createProjectIssue).not.toHaveBeenCalled();
  });
});
