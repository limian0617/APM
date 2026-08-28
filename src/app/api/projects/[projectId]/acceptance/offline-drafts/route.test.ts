import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const authorization = vi.hoisted(() => ({ decideAuthorization: vi.fn() }));
const drafts = vi.hoisted(() => ({
  listSatOfflineDrafts: vi.fn(),
  submitSatOfflineDraft: vi.fn()
}));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/lib/auth/authorize", () => authorization);
vi.mock("@/modules/acceptance/application/sat-offline-draft-service", () => drafts);
vi.mock("@/modules/platform-api/application/idempotent-command", () => ({
  idempotentCommandResponse: async (input: {
    execute: (transaction: undefined) => Promise<{ status: number; body: unknown }>;
  }) => {
    const result = await input.execute(undefined);
    return Response.json(result.body, { status: result.status });
  }
}));

import { GET, POST } from "./route";

describe("SAT offline draft routes", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    authorization.decideAuthorization.mockReset();
    drafts.listSatOfflineDrafts.mockReset();
    drafts.submitSatOfflineDraft.mockReset();
  });

  it("requires project acceptance read access before listing the review queue", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });
    const response = await GET(
      new Request("http://localhost/api/projects/p-1/acceptance/offline-drafts"),
      { params: Promise.resolve({ projectId: "p-1" }) }
    );
    expect(response.status).toBe(403);
    expect(drafts.listSatOfflineDrafts).not.toHaveBeenCalled();
  });

  it("submits only a strict current-project SAT draft payload", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "u-1" },
      project: { departmentId: "quality", memberRoles: ["QUALITY"] }
    });
    drafts.submitSatOfflineDraft.mockResolvedValue({
      idempotent: false,
      status: "PENDING_REVIEW",
      submission: { id: "draft-1" }
    });
    const response = await POST(
      new Request("http://localhost/api/projects/p-1/acceptance/offline-drafts", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "offline-1" },
        body: JSON.stringify({
          clientDraftId: "offline-1",
          batchId: "batch-1",
          itemId: "item-1",
          baselineBatchVersion: 2,
          baselineResultRevisionId: null,
          decision: "PASS",
          measuredValue: "220",
          measuredUnit: "V",
          note: "离线采集",
          capturedAt: "2026-08-10T10:00:00.000Z"
        })
      }),
      { params: Promise.resolve({ projectId: "p-1" }) }
    );
    expect(response.status).toBe(202);
    expect(drafts.submitSatOfflineDraft).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-1", actorId: "u-1", batchId: "batch-1" }),
      undefined
    );
  });
});
