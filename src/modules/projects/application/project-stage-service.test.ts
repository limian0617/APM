import { describe, expect, it } from "vitest";

import { validateStageTransition } from "../domain/project-stage";
import { requiresReleaseAuthorization, stageAllowedActions } from "./project-stage-service";

describe("APM-030 project stage command actions", () => {
  it("exposes only lifecycle actions allowed by the current stage status", () => {
    expect(stageAllowedActions("NOT_STARTED")).toEqual(["AUTHORIZE", "SKIP"]);
    expect(stageAllowedActions("AUTHORIZED")).toEqual(["START", "SKIP"]);
    expect(stageAllowedActions("IN_PROGRESS")).toEqual(["AWAIT_GATE"]);
    expect(stageAllowedActions("AWAITING_GATE")).toEqual(["COMPLETE"]);
    expect(stageAllowedActions("CONDITIONALLY_RELEASED")).toEqual([]);
    expect(stageAllowedActions("COMPLETED")).toEqual([]);
  });

  it("does not allow the generic stage transition to conditionally release or complete a Gate", () => {
    try {
      validateStageTransition("AWAITING_GATE", "CONDITIONALLY_RELEASED", "旁路条件放行");
      throw new Error("Expected the generic transition to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "STAGE_TRANSITION_INVALID" });
    }

    try {
      validateStageTransition("CONDITIONALLY_RELEASED", "COMPLETED", "旁路完成");
      throw new Error("Expected the generic completion to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "STAGE_TRANSITION_INVALID" });
    }
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
