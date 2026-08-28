import { describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const selection = vi.hoisted(() => ({ createDrawingSelectionSet: vi.fn() }));
const idempotent = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/drawings/application/drawing-selection-service", () => selection);
vi.mock("@/modules/platform-api/application/idempotent-command", () => idempotent);

import { POST } from "./route";

describe("drawing selection routes", () => {
  it("requires procurement tracking permission before parsing a command", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });
    const response = await POST(
      new Request("http://localhost/api/projects/project-1/drawing-selections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json"
      }),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );
    expect(response.status).toBe(403);
    expect(idempotent.idempotentCommandResponse).not.toHaveBeenCalled();
  });
});
