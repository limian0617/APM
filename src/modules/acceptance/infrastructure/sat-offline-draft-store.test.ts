import { describe, expect, it } from "vitest";

import { offlineDraftDisplayState } from "./sat-offline-draft-store";

describe("APM-103 SAT offline draft browser storage", () => {
  it("keeps local, syncing and server review states distinguishable", () => {
    expect(offlineDraftDisplayState({ localStatus: "LOCAL_ONLY", serverStatus: null })).toBe(
      "仅本地"
    );
    expect(offlineDraftDisplayState({ localStatus: "PENDING_SYNC", serverStatus: null })).toBe(
      "待同步"
    );
    expect(offlineDraftDisplayState({ localStatus: "SYNC_FAILED", serverStatus: null })).toBe(
      "同步失败，可重试"
    );
    expect(
      offlineDraftDisplayState({ localStatus: "SYNCED", serverStatus: "PENDING_REVIEW" })
    ).toBe("待复核");
    expect(offlineDraftDisplayState({ localStatus: "SYNCED", serverStatus: "CONFLICT" })).toBe(
      "冲突，保留双方值"
    );
    expect(offlineDraftDisplayState({ localStatus: "SYNCED", serverStatus: "ACCEPTED" })).toBe(
      "已接受"
    );
    expect(offlineDraftDisplayState({ localStatus: "SYNCED", serverStatus: "REJECTED" })).toBe(
      "已拒绝"
    );
  });
});
