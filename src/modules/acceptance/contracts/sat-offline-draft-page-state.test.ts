import { describe, expect, it } from "vitest";

import { buildSatOfflineDraftQueueState } from "./sat-offline-draft-page-state";

describe("APM-103 SAT offline draft queue page state", () => {
  it("keeps a denied reviewer queue separate from an empty queue", () => {
    expect(
      buildSatOfflineDraftQueueState({ projectId: "p-1", result: { status: 403, fetchedAt: null } })
    ).toEqual({ projectId: "p-1", status: "denied" });
    expect(
      buildSatOfflineDraftQueueState({
        projectId: "p-1",
        result: { status: 200, body: { drafts: [] }, fetchedAt: "2026-08-10T10:00:00.000Z" }
      })
    ).toMatchObject({ status: "empty" });
  });

  it("rejects malformed or cross-project queue data instead of treating it as no drafts", () => {
    expect(
      buildSatOfflineDraftQueueState({
        projectId: "p-1",
        result: { status: 200, body: {}, fetchedAt: null }
      })
    ).toMatchObject({ status: "error", retryable: false });
    expect(
      buildSatOfflineDraftQueueState({
        projectId: "p-1",
        result: { status: 200, body: { drafts: [{ projectId: "p-2" }] }, fetchedAt: null }
      })
    ).toMatchObject({ status: "error", retryable: false });
  });
});
