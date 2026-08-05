import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);

import { POST } from "./route";

describe("POST /api/projects/[projectId]/cockpit/resource-load/refresh", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
  });

  it("requires project plan update permission before validating the command", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });

    const response = await POST(
      new Request("http://localhost/api/projects/project-1/cockpit/resource-load/refresh", {
        method: "POST"
      }),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );

    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "project-1",
      "PROJECT_PLAN_UPDATE"
    );
    expect(response.status).toBe(403);
  });

  it("requires an idempotency key and rejects undeclared body fields", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });

    const missingKey = await POST(
      new Request("http://localhost/api/projects/project-1/cockpit/resource-load/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Refresh resource load" })
      }),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );
    expect(missingKey.status).toBe(400);
    await expect(missingKey.json()).resolves.toMatchObject({ error: { code: "INVALID_HEADERS" } });

    const unknownField = await POST(
      new Request("http://localhost/api/projects/project-1/cockpit/resource-load/refresh", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "refresh-1" },
        body: JSON.stringify({ reason: "Refresh resource load", force: true })
      }),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );
    expect(unknownField.status).toBe(422);
    await expect(unknownField.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" }
    });
  });
});
