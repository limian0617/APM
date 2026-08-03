import { describe, expect, it } from "vitest";

import { validateAdjacentStageRelease, validateStageTransition } from "./project-stage";

describe("APM-030 project stage rules", () => {
  it("allows normal stage advancement one state at a time", () => {
    expect(validateStageTransition("NOT_STARTED", "AUTHORIZED")).toBe("AUTHORIZED");
    expect(validateStageTransition("AUTHORIZED", "IN_PROGRESS")).toBe("IN_PROGRESS");
    expect(validateStageTransition("IN_PROGRESS", "AWAITING_GATE")).toBe("AWAITING_GATE");
    expect(validateStageTransition("AWAITING_GATE", "COMPLETED")).toBe("COMPLETED");
  });

  it("rejects a jump from not started to completed", () => {
    expect(() => validateStageTransition("NOT_STARTED", "COMPLETED")).toThrowError(
      expect.objectContaining({ code: "STAGE_TRANSITION_INVALID" })
    );
  });

  it("requires a reason for exceptional stage states", () => {
    expect(() => validateStageTransition("AWAITING_GATE", "CONDITIONALLY_RELEASED")).toThrowError(
      expect.objectContaining({ code: "STAGE_EXCEPTION_REASON_REQUIRED" })
    );
    expect(() => validateStageTransition("NOT_STARTED", "SKIPPED", "  ")).toThrowError(
      expect.objectContaining({ code: "STAGE_EXCEPTION_REASON_REQUIRED" })
    );
    expect(validateStageTransition("AWAITING_GATE", "CONDITIONALLY_RELEASED", "风险已记录")).toBe(
      "CONDITIONALLY_RELEASED"
    );
  });

  it("authorizes releases only between adjacent stages in the same project", () => {
    expect(() =>
      validateAdjacentStageRelease({
        projectId: "project-1",
        fromStage: { projectId: "project-1", sequence: 2 },
        nextStage: { projectId: "project-1", sequence: 3 }
      })
    ).not.toThrow();
    expect(() =>
      validateAdjacentStageRelease({
        projectId: "project-1",
        fromStage: { projectId: "project-1", sequence: 2 },
        nextStage: { projectId: "project-1", sequence: 4 }
      })
    ).toThrowError(expect.objectContaining({ code: "STAGE_RELEASE_NOT_ADJACENT" }));
  });
});
