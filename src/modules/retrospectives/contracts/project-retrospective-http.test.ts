import { describe, expect, it } from "vitest";

import {
  createRetrospectiveBodySchema,
  reviewRetrospectiveBodySchema,
  submitRetrospectiveBodySchema
} from "./project-retrospective-http";

describe("project retrospective HTTP DTOs", () => {
  it("accepts exact source IDs and rejects client-controlled snapshots/checksums", () => {
    const result = createRetrospectiveBodySchema.safeParse({
      archiveVersionId: "archive-a",
      expectedAggregateVersion: null,
      content: {
        deliverySummary: { summary: "summary" },
        successfulPractices: { practices: ["practice"] },
        shortcomings: { items: ["shortcoming"] },
        improvements: { actions: ["action"] },
        knowledgeDisposition: { disposition: "PUBLISH_CANDIDATE" },
        ipDeclaration: { customerOwned: true, sanitized: true, excludedFields: [] }
      },
      contributions: [],
      participantMembershipIds: [],
      issueHistoryIds: [],
      snapshotJson: { forged: true },
      contentChecksum: "forged"
    });
    expect(result.success).toBe(false);
  });

  it("requires an optimistic version for submit and review", () => {
    expect(submitRetrospectiveBodySchema.safeParse({}).success).toBe(false);
    expect(
      reviewRetrospectiveBodySchema.safeParse({ decision: "APPROVED", reason: "review" }).success
    ).toBe(false);
  });
});
