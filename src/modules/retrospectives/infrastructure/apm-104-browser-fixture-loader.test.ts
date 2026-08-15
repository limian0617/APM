import { afterEach, describe, expect, it, vi } from "vitest";

const fixtureDatabase = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  user: { createMany: vi.fn() },
  userRole: { upsert: vi.fn() }
}));
const archiveJobHandlers = vi.hoisted(() => ({ createArchiveJobHandlers: vi.fn() }));
const jobRunner = vi.hoisted(() => ({ runJobBatch: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: fixtureDatabase }));
vi.mock("@/workers/archive-job-handlers", () => archiveJobHandlers);
vi.mock("@/workers/job-runner", () => jobRunner);

import {
  buildApm104BrowserFixture,
  consumeApm104BrowserIdentityToken,
  issueApm104BrowserIdentityToken,
  provisionApm104BrowserFixture,
  runApm104FixtureArchiveWorkerStage,
  validateApm104FixtureEnvironment
} from "./apm-104-browser-fixture-loader";

describe("APM-104 browser fixture", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    fixtureDatabase.$queryRaw.mockReset();
    fixtureDatabase.user.createMany.mockReset();
    fixtureDatabase.userRole.upsert.mockReset();
    archiveJobHandlers.createArchiveJobHandlers.mockReset();
    jobRunner.runJobBatch.mockReset();
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

  it("runs each archive fixture stage through exactly one successful durable job batch", async () => {
    const generationHandler = vi.fn();
    const integrityHandler = vi.fn();
    archiveJobHandlers.createArchiveJobHandlers.mockReturnValue({
      "archive.generate": generationHandler,
      "archive.integrity.check": integrityHandler
    });
    jobRunner.runJobBatch
      .mockResolvedValueOnce({
        materializedJobIds: ["generation-job"],
        claimedCount: 1,
        outcomes: [{ jobId: "generation-job", status: "SUCCEEDED" }]
      })
      .mockResolvedValueOnce({
        materializedJobIds: ["integrity-job"],
        claimedCount: 1,
        outcomes: [{ jobId: "integrity-job", status: "SUCCEEDED" }]
      });

    await expect(
      runApm104FixtureArchiveWorkerStage({
        eventType: "archive.generate",
        projectId: "project-1",
        storage: {} as never
      })
    ).resolves.toBe("generation-job");
    await expect(
      runApm104FixtureArchiveWorkerStage({
        eventType: "archive.integrity.check",
        projectId: "project-1",
        storage: {} as never
      })
    ).resolves.toBe("integrity-job");

    expect(archiveJobHandlers.createArchiveJobHandlers).toHaveBeenNthCalledWith(1);
    expect(archiveJobHandlers.createArchiveJobHandlers).toHaveBeenNthCalledWith(2, {
      storage: expect.anything()
    });
    expect(jobRunner.runJobBatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workerId: "apm104-browser-fixture-project-1-archive-generate",
        handlers: { "archive.generate": generationHandler },
        policy: {
          claimBatchSize: 1,
          leaseSeconds: 60,
          retryBaseSeconds: 1,
          retryMaxSeconds: 10,
          defaultMaxAttempts: 1
        }
      })
    );
    expect(jobRunner.runJobBatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workerId: "apm104-browser-fixture-project-1-archive-integrity-check",
        handlers: { "archive.integrity.check": integrityHandler }
      })
    );
  });

  it("fails closed unless a fixture archive stage materializes, claims, and completes one job", async () => {
    const generationHandler = vi.fn();
    archiveJobHandlers.createArchiveJobHandlers.mockReturnValue({
      "archive.generate": generationHandler
    });
    jobRunner.runJobBatch.mockResolvedValue({
      materializedJobIds: ["generation-job"],
      claimedCount: 0,
      outcomes: []
    });

    await expect(
      runApm104FixtureArchiveWorkerStage({
        eventType: "archive.generate",
        projectId: "project-1",
        storage: {} as never
      })
    ).rejects.toThrow("APM104_BROWSER_FIXTURE_ARCHIVE_WORKER_STAGE_FAILED");
  });
});
