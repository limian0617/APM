import { describe, expect, it } from "vitest";

import { developmentAcceptanceFixture } from "./page";
import { acceptanceCommandsForBatch } from "./acceptance-page-client";

describe("developmentAcceptanceFixture", () => {
  it("provides only explicit states for browser acceptance", () => {
    expect(developmentAcceptanceFixture("project-1", "normal")).toMatchObject({
      status: "ready",
      batches: [{ id: "acceptance-batch-demo", projectId: "project-1" }]
    });
    expect(developmentAcceptanceFixture("project-1", "unknown")).toBeNull();
    expect(developmentAcceptanceFixture("project-1", "denied")).toMatchObject({ status: "denied" });
    expect(developmentAcceptanceFixture("project-1", "offline")).toMatchObject({
      status: "ready",
      batches: [{ acceptanceType: "SAT", status: "IN_PROGRESS" }]
    });
  });
});

describe("acceptance batch command visibility", () => {
  it("uses server allowedActions and batch state for the command closure", () => {
    expect(
      acceptanceCommandsForBatch({ status: "DRAFT", allowedActions: ["START_BATCH", "LOCK_BATCH"] })
    ).toEqual(["START_BATCH"]);
    expect(
      acceptanceCommandsForBatch({
        status: "IN_PROGRESS",
        allowedActions: ["RECORD_RESULT", "REVISE_RESULT", "LOCK_BATCH"]
      })
    ).toEqual(["RECORD_RESULT", "REVISE_RESULT", "LOCK_BATCH"]);
    expect(
      acceptanceCommandsForBatch({ status: "LOCKED", allowedActions: ["LOCK_BATCH"] })
    ).toEqual([]);
  });
});
