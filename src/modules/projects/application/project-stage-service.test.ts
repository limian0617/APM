import { describe, expect, it } from "vitest";

import { requiresReleaseAuthorization, stageAllowedActions } from "./project-stage-service";

describe("APM-030 project stage command actions", () => {
  it("exposes only lifecycle actions allowed by the current stage status", () => {
    expect(stageAllowedActions("NOT_STARTED")).toEqual(["AUTHORIZE", "SKIP"]);
    expect(stageAllowedActions("AUTHORIZED")).toEqual(["START", "SKIP"]);
    expect(stageAllowedActions("IN_PROGRESS")).toEqual(["AWAIT_GATE"]);
    expect(stageAllowedActions("AWAITING_GATE")).toEqual(["COMPLETE", "CONDITIONALLY_RELEASE"]);
    expect(stageAllowedActions("CONDITIONALLY_RELEASED")).toEqual(["COMPLETE"]);
    expect(stageAllowedActions("COMPLETED")).toEqual([]);
  });

  it("requires an explicit release only when the previous stage is unfinished", () => {
    expect(
      requiresReleaseAuthorization({ isFirstStage: true, previousStageCompleted: false })
    ).toBe(false);
    expect(
      requiresReleaseAuthorization({ isFirstStage: false, previousStageCompleted: true })
    ).toBe(false);
    expect(
      requiresReleaseAuthorization({ isFirstStage: false, previousStageCompleted: false })
    ).toBe(true);
  });
});
