import { describe, expect, it } from "vitest";

import { buildArchivePageState } from "./archive-page-state";

describe("archive page state", () => {
  it("keeps denied and retryable error states explicit", () => {
    expect(buildArchivePageState({ projectId: "p1", result: { status: 403 } })).toEqual({
      projectId: "p1",
      status: "denied"
    });
    expect(buildArchivePageState({ projectId: "p1", result: { status: 503 } })).toEqual({
      projectId: "p1",
      status: "error",
      retryable: true
    });
  });

  it("does not turn a missing archive into a successful empty version", () => {
    expect(
      buildArchivePageState({ projectId: "p1", result: { status: 200, body: { archive: null } } })
    ).toMatchObject({ projectId: "p1", status: "empty" });
  });
});
