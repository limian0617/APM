import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  provisionApm104BrowserFixture: vi.fn(),
  issueApm104BrowserIdentityToken: vi.fn()
}));
vi.mock("@/modules/retrospectives/infrastructure/apm-104-browser-fixture-loader", () => fixture);
import { POST } from "./route";

describe("APM-104 browser fixture route", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns 404 outside development or test", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await POST()).status).toBe(404);
  });

  it("returns one distinct single-use token per fixture identity", async () => {
    vi.stubEnv("NODE_ENV", "test");
    fixture.provisionApm104BrowserFixture.mockResolvedValue({
      sourceProjectId: "source",
      targetProjectId: "target",
      archiveAId: "archive-a",
      users: {
        sourceManagerId: "source-manager",
        retrospectiveReviewerId: "retrospective-reviewer",
        knowledgeReviewerId: "knowledge-reviewer",
        targetManagerId: "target-manager"
      }
    });
    fixture.issueApm104BrowserIdentityToken.mockImplementation((id) => `token-${id}`);

    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        identityTokens: {
          sourceManager: "token-source-manager",
          retrospectiveReviewer: "token-retrospective-reviewer",
          knowledgeReviewer: "token-knowledge-reviewer",
          targetManager: "token-target-manager"
        }
      })
    );
  });
});
