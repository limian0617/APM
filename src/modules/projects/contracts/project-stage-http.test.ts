import { describe, expect, it } from "vitest";

import { parseStageReleasePayload, parseStageTransitionPayload } from "./project-stage-http";

describe("APM-030 project stage HTTP contracts", () => {
  it("requires an optimistic version and rejects unknown transition fields", () => {
    expect(() => parseStageTransitionPayload({ toStatus: "IN_PROGRESS" })).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" })
    );
    expect(() =>
      parseStageTransitionPayload({
        version: 1,
        toStatus: "IN_PROGRESS",
        reason: "Start stage work",
        bypass: true
      })
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("requires an explicit scope and matching adjacent-stage identities for release requests", () => {
    expect(() =>
      parseStageReleasePayload({
        scope: "DELIVERY_UNIT",
        fromStageId: "stage-0",
        toStageId: "stage-1",
        reason: "Release next stage"
      })
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(
      parseStageReleasePayload({
        scope: "PROJECT",
        fromStageId: "stage-0",
        toStageId: "stage-1",
        reason: "Release next stage"
      })
    ).toMatchObject({ scope: "PROJECT" });
  });
});
