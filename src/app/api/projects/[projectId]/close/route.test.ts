import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const service = vi.hoisted(() => ({ closeProject: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => guard);
vi.mock("@/modules/projects/application/project-close-service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/modules/projects/application/project-close-service")
  >()),
  ...service
}));

import { POST } from "./route";

const context = { params: Promise.resolve({ projectId: "project-1" }) };
const body = {
  archiveVersionId: "archive-b-1",
  g9SubmissionId: "g9-submission-1",
  expectedProjectVersion: 4,
  operationId: "close-operation-1"
};
const traceId = "0123456789abcdef0123456789abcdef";

function request(value: unknown = body): Request {
  return new Request("http://localhost/api/projects/project-1/close", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "close-idempotency-1",
      traceparent: `00-${traceId}-0123456789abcdef-01`
    },
    body: JSON.stringify(value)
  });
}

describe("POST /api/projects/[projectId]/close", () => {
  beforeEach(() => {
    guard.authorizeProjectRequest.mockReset();
    service.closeProject.mockReset();
    guard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "quality-user-1" },
      project: { departmentId: "quality" }
    });
    service.closeProject.mockResolvedValue({
      projectId: "project-1",
      status: "CLOSED",
      finalArchiveVersionId: "archive-b-1",
      idempotent: false
    });
  });

  it("passes only the server-normalized command audit context to the close service", async () => {
    expect((await POST(request(), context)).status).toBe(200);

    expect(service.closeProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        actorId: "quality-user-1",
        operationId: "close-operation-1",
        auditContext: expect.objectContaining({
          actorId: "quality-user-1",
          projectId: "project-1",
          departmentId: "quality",
          traceId,
          operationId: "close-operation-1",
          reason: "关闭项目"
        })
      })
    );
  });

  it("rejects client-injected audit context before invoking the close service", async () => {
    expect(
      (
        await POST(
          request({
            ...body,
            auditContext: { traceId: "f".repeat(32) },
            traceId: "f".repeat(32)
          }),
          context
        )
      ).status
    ).toBe(422);
    expect(service.closeProject).not.toHaveBeenCalled();
  });
});
