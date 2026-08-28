import { describe, expect, it } from "vitest";

import {
  DocumentReviewError,
  assertRequiredReviewClosure,
  assertReviewDecision,
  validateDocumentVersionRelationTarget
} from "./document-review";

describe("APM-051 document review policy", () => {
  it("does not allow a required review to approve while required feedback remains open", () => {
    expect(() =>
      assertReviewDecision({
        currentStatus: "CHANGES_REQUESTED",
        nextStatus: "APPROVED",
        openRequiredCommentCount: 1
      })
    ).toThrowError(
      expect.objectContaining({ code: "DOCUMENT_REVIEW_FEEDBACK_UNRESOLVED", status: 409 })
    );
  });

  it("accepts exactly one matching typed business-relation target", () => {
    expect(
      validateDocumentVersionRelationTarget({
        targetType: "GATE_INSTANCE",
        targetIds: { gateInstanceId: "gate-1" }
      })
    ).toEqual({
      targetType: "GATE_INSTANCE",
      targetIds: { gateInstanceId: "gate-1" }
    });

    expect(() =>
      validateDocumentVersionRelationTarget({
        targetType: "GATE_INSTANCE",
        targetIds: { gateInstanceId: "gate-1", planningTaskId: "task-1" }
      })
    ).toThrowError(DocumentReviewError);
  });

  it("requires every required reviewer to approve and every required comment to close", () => {
    expect(() =>
      assertRequiredReviewClosure({
        reviews: [{ id: "review-1", required: true, status: "PENDING" }],
        comments: []
      })
    ).toThrowError(expect.objectContaining({ code: "DOCUMENT_REVIEW_REQUIRED", status: 409 }));

    expect(() =>
      assertRequiredReviewClosure({
        reviews: [{ id: "review-1", required: true, status: "APPROVED" }],
        comments: [{ id: "comment-1", required: true, resolvedAt: null }]
      })
    ).toThrowError(
      expect.objectContaining({ code: "DOCUMENT_REVIEW_FEEDBACK_UNRESOLVED", status: 409 })
    );

    expect(
      assertRequiredReviewClosure({
        reviews: [{ id: "review-1", required: true, status: "APPROVED" }],
        comments: [
          { id: "comment-1", required: true, resolvedAt: new Date("2026-08-05T00:00:00Z") }
        ]
      })
    ).toBe(true);
  });
});
