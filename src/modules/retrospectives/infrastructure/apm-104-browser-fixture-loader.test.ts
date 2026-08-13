import { afterEach, describe, expect, it, vi } from "vitest";

const fixtureDatabase = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  user: { createMany: vi.fn() },
  userRole: { upsert: vi.fn() }
}));

vi.mock("@/lib/db", () => ({ db: fixtureDatabase }));

import {
  buildApm104BrowserFixture,
  consumeApm104BrowserIdentityToken,
  issueApm104BrowserIdentityToken,
  provisionApm104BrowserFixture,
  validateApm104FixtureEnvironment
} from "./apm-104-browser-fixture-loader";

describe("APM-104 browser fixture", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    fixtureDatabase.$queryRaw.mockReset();
    fixtureDatabase.user.createMany.mockReset();
    fixtureDatabase.userRole.upsert.mockReset();
  });
  it("returns exact IDs for a disposable V2 workflow without pre-closing it", async () => {
    await expect(
      buildApm104BrowserFixture({
        create: async () => ({
          sourceProjectId: "source-project",
          targetProjectId: "target-project",
          archiveAId: "archive-a",
          users: {
            sourceManagerId: "source-manager",
            retrospectiveReviewerId: "retrospective-reviewer",
            knowledgeReviewerId: "knowledge-reviewer",
            targetManagerId: "target-manager"
          }
        })
      })
    ).resolves.toEqual(
      expect.objectContaining({
        sourceProjectId: "source-project",
        archiveAId: "archive-a",
        closed: false,
        workflow: expect.arrayContaining([
          "CREATE_RETROSPECTIVE",
          "SUBMIT_RETROSPECTIVE",
          "REVIEW_RETROSPECTIVE"
        ])
      })
    );
  });

  it("fails closed before writes unless enabled on an apm104_fixture database", () => {
    expect(() =>
      validateApm104FixtureEnvironment({ enabled: false, databaseName: "apm104_fixture_x" })
    ).toThrow("APM104_BROWSER_FIXTURE_DISABLED");
    expect(() =>
      validateApm104FixtureEnvironment({ enabled: true, databaseName: "application" })
    ).toThrow("APM104_BROWSER_FIXTURE_DATABASE_NOT_DISPOSABLE");
    expect(() =>
      validateApm104FixtureEnvironment({ enabled: true, databaseName: "apm104_fixture_x" })
    ).not.toThrow();
  });

  it("keeps four fixture identities distinct", async () => {
    const fixture = await buildApm104BrowserFixture({
      create: async () => ({
        sourceProjectId: "source-project",
        targetProjectId: "target-project",
        archiveAId: "archive-a",
        users: {
          sourceManagerId: "source-manager",
          retrospectiveReviewerId: "retrospective-reviewer",
          knowledgeReviewerId: "knowledge-reviewer",
          targetManagerId: "target-manager"
        }
      })
    });
    expect(new Set(Object.values(fixture.users)).size).toBe(4);
  });

  it("issues a different one-time identity token for each user and rejects repeats or forgeries", () => {
    const userIds = [
      "source-manager",
      "retrospective-reviewer",
      "knowledge-reviewer",
      "target-manager"
    ];
    const tokens = userIds.map(issueApm104BrowserIdentityToken);
    expect(new Set(tokens).size).toBe(4);
    expect(tokens.map(consumeApm104BrowserIdentityToken)).toEqual(userIds);
    expect(tokens.map(consumeApm104BrowserIdentityToken)).toEqual([null, null, null, null]);
    expect(consumeApm104BrowserIdentityToken("forged-token")).toBeNull();
  });

  it("rejects a disabled or non-disposable provision before attempting a business write", async () => {
    fixtureDatabase.$queryRaw.mockResolvedValue([{ current_database: "production" }]);
    vi.stubEnv("APM104_BROWSER_FIXTURE_ENABLED", "false");
    await expect(provisionApm104BrowserFixture()).rejects.toThrow(
      "APM104_BROWSER_FIXTURE_DISABLED"
    );
    expect(fixtureDatabase.user.createMany).not.toHaveBeenCalled();

    fixtureDatabase.$queryRaw.mockResolvedValue([{ current_database: "application" }]);
    vi.stubEnv("APM104_BROWSER_FIXTURE_ENABLED", "true");
    await expect(provisionApm104BrowserFixture()).rejects.toThrow(
      "APM104_BROWSER_FIXTURE_DATABASE_NOT_DISPOSABLE"
    );
    expect(fixtureDatabase.user.createMany).not.toHaveBeenCalled();
  });
});
