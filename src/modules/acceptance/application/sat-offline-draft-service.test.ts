import { describe, expect, it } from "vitest";

import { buildOfflineDraftServerSnapshot } from "./sat-offline-draft-service";

describe("SAT offline draft application boundary", () => {
  it("keeps client capture time and server result facts separate", () => {
    const snapshot = buildOfflineDraftServerSnapshot({
      revision: {
        id: "revision-1",
        decision: "PASS",
        measuredValue: "220",
        measuredUnit: "V",
        note: "在线结果"
      },
      capturedAt: "2026-08-10T10:00:00.000Z",
      serverCapturedAt: new Date("2026-08-10T10:01:00.000Z"),
      currentBatchVersion: 4
    });

    expect(snapshot).toMatchObject({
      currentRevisionId: "revision-1",
      currentDecision: "PASS",
      capturedAt: "2026-08-10T10:00:00.000Z",
      serverCapturedAt: "2026-08-10T10:01:00.000Z",
      currentBatchVersion: 4
    });
  });
});
