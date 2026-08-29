import { describe, expect, it } from "vitest";

import {
  AcceptanceOfflineDraftPolicyError,
  assertOfflineDraftReviewTransition,
  compareOfflineDraftBaseline,
  resolveOfflineDraftReviewStatus,
  offlineDraftChecksum,
  validateSatOfflineDraft
} from "./sat-offline-draft-policy";

const draft = {
  clientDraftId: "draft-1",
  projectId: "project-1",
  batchId: "batch-1",
  itemId: "item-1",
  baselineBatchVersion: 3,
  baselineResultRevisionId: "revision-1",
  decision: "FAIL" as const,
  measuredValue: "8.2",
  measuredUnit: "mm",
  note: "现场记录",
  capturedAt: "2026-08-10T09:00:00.000Z"
};

describe("APM-103 SAT offline draft policy", () => {
  it("normalizes a stable SAT draft checksum independently of object key order", () => {
    const first = offlineDraftChecksum(draft);
    const second = offlineDraftChecksum({ ...draft, note: "现场记录" });

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toBe(first);
  });

  it("rejects non-SAT drafts and invalid client capture data", () => {
    expect(() => validateSatOfflineDraft({ ...draft, acceptanceType: "FAT" })).toThrow(
      AcceptanceOfflineDraftPolicyError
    );
    try {
      validateSatOfflineDraft({ ...draft, capturedAt: "not-a-date" });
      throw new Error("expected invalid capturedAt");
    } catch (error) {
      expect(error).toMatchObject({ code: "ACCEPTANCE_OFFLINE_DRAFT_CAPTURED_AT_INVALID" });
    }
    try {
      validateSatOfflineDraft({ ...draft, decision: "UNKNOWN" as "PASS" });
      throw new Error("expected invalid decision");
    } catch (error) {
      expect(error).toMatchObject({ code: "ACCEPTANCE_DECISION_INVALID" });
    }
  });

  it("keeps a conflict when the formal result changed, including null transitions", () => {
    expect(
      compareOfflineDraftBaseline({
        baselineRevisionId: "revision-1",
        currentRevisionId: "revision-1"
      })
    ).toBe("PENDING_REVIEW");
    expect(
      compareOfflineDraftBaseline({
        baselineRevisionId: "revision-1",
        currentRevisionId: "revision-2"
      })
    ).toBe("CONFLICT");
    expect(
      compareOfflineDraftBaseline({ baselineRevisionId: null, currentRevisionId: "revision-2" })
    ).toBe("CONFLICT");
  });

  it("allows only explicit conflict correction and terminal review transitions", () => {
    try {
      assertOfflineDraftReviewTransition("CONFLICT", "ACCEPT");
      throw new Error("expected conflict");
    } catch (error) {
      expect(error).toMatchObject({ code: "ACCEPTANCE_OFFLINE_DRAFT_CONFLICT" });
    }
    expect(assertOfflineDraftReviewTransition("CONFLICT", "ACCEPT_WITH_CORRECTION")).toBe(
      "ACCEPTED"
    );
    expect(assertOfflineDraftReviewTransition("PENDING_REVIEW", "REJECT")).toBe("REJECTED");
    try {
      assertOfflineDraftReviewTransition("ACCEPTED", "REJECT");
      throw new Error("expected already reviewed");
    } catch (error) {
      expect(error).toMatchObject({ code: "ACCEPTANCE_OFFLINE_DRAFT_ALREADY_REVIEWED" });
    }
  });

  it("rechecks the current server revision when reviewing a previously pending draft", () => {
    try {
      resolveOfflineDraftReviewStatus({
        submissionStatus: "PENDING_REVIEW",
        baselineRevisionId: "revision-1",
        currentRevisionId: "revision-2",
        decision: "ACCEPT"
      });
      throw new Error("expected stale review conflict");
    } catch (error) {
      expect(error).toMatchObject({ code: "ACCEPTANCE_OFFLINE_DRAFT_CONFLICT" });
    }

    expect(
      resolveOfflineDraftReviewStatus({
        submissionStatus: "PENDING_REVIEW",
        baselineRevisionId: "revision-1",
        currentRevisionId: "revision-2",
        decision: "ACCEPT_WITH_CORRECTION"
      })
    ).toBe("ACCEPTED");
  });
});
