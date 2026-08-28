import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const drafts = vi.hoisted(() => ({ reviewSatOfflineDraft: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/acceptance/application/sat-offline-draft-service", () => drafts);
vi.mock("@/modules/platform-api/application/idempotent-command", () => ({
  idempotentCommandResponse: async (input: {
    execute: (transaction: undefined) => Promise<{ status: number; body: unknown }>;
  }) => {
    const result = await input.execute(undefined);
    return Response.json(result.body, { status: result.status });
  }
}));

import { POST } from "./route";

describe("SAT offline draft review route", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    drafts.reviewSatOfflineDraft.mockReset();
  });

  it("requires the review permission before accepting or rejecting a draft", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });
    const response = await POST(
      new Request("http://localhost/api/projects/p-1/acceptance/offline-drafts/draft-1/review", {
        method: "POST"
      }),
      { params: Promise.resolve({ projectId: "p-1", submissionId: "draft-1" }) }
    );
    expect(response.status).toBe(403);
    expect(drafts.reviewSatOfflineDraft).not.toHaveBeenCalled();
  });

  it("passes a corrective conflict review with the route project scope", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "reviewer-1" },
      project: { departmentId: "quality" }
    });
    drafts.reviewSatOfflineDraft.mockResolvedValue({
      submission: { id: "draft-1", status: "ACCEPTED" }
    });
    const response = await POST(
      new Request("http://localhost/api/projects/p-1/acceptance/offline-drafts/draft-1/review", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "review-1" },
        body: JSON.stringify({
          version: 1,
          decision: "ACCEPT_WITH_CORRECTION",
          correctedDecision: "PASS",
          reason: "现场复核确认",
          evidenceFileIds: []
        })
      }),
      { params: Promise.resolve({ projectId: "p-1", submissionId: "draft-1" }) }
    );
    expect(response.status).toBe(200);
    expect(drafts.reviewSatOfflineDraft).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-1", submissionId: "draft-1", actorId: "reviewer-1" }),
      undefined
    );
  });
});
