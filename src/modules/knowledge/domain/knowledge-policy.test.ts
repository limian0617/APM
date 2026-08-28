import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_VERSION_STATUS,
  assertKnowledgeSourceRead,
  assertKnowledgeVersionTransition,
  buildKnowledgeContent,
  type KnowledgeDraft
} from "./knowledge-policy";

function draft(overrides: Partial<KnowledgeDraft> = {}): KnowledgeDraft {
  return {
    title: "  Servo jitter tuning  ",
    sanitizedSummary: "  Stabilize servo tuning without customer identifiers.  ",
    experienceType: "COMMISSIONING",
    discipline: "ELECTRICAL",
    keywords: [" servo ", "JITTER", "servo"],
    applicableProjectTypes: ["CUSTOMER_DELIVERY"],
    applicableStageCodes: ["S5"],
    preconditions: "Baseline parameters are backed up.",
    recommendedPractice: "Tune one axis at a time and record the response.",
    antiPatterns: "Do not copy a customer's parameter file.",
    limitations: "Requires a stable no-load commissioning condition.",
    ipSanitizationDeclaration: "Customer names, files, and confidential parameters were removed.",
    internalReusable: true,
    ...overrides
  };
}

describe("knowledge policy", () => {
  it("normalizes reusable knowledge text and derives a deterministic content checksum", () => {
    const first = buildKnowledgeContent(draft());
    const second = buildKnowledgeContent(
      draft({
        title: "Servo jitter tuning",
        keywords: ["JITTER", "servo"]
      })
    );

    expect(first.value).toMatchObject({
      title: "Servo jitter tuning",
      normalizedKeywords: ["jitter", "servo"],
      normalizedKeywordsText: "jitter servo"
    });
    expect(first.contentChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.contentChecksum).toBe(first.contentChecksum);
  });

  it("allows only the immutable knowledge version lifecycle", () => {
    expect(assertKnowledgeVersionTransition(KNOWLEDGE_VERSION_STATUS.DRAFT, "SUBMIT")).toBe(
      KNOWLEDGE_VERSION_STATUS.IN_REVIEW
    );
    expect(assertKnowledgeVersionTransition(KNOWLEDGE_VERSION_STATUS.IN_REVIEW, "PUBLISH")).toBe(
      KNOWLEDGE_VERSION_STATUS.PUBLISHED
    );
    expect(assertKnowledgeVersionTransition(KNOWLEDGE_VERSION_STATUS.PUBLISHED, "REVOKE")).toBe(
      KNOWLEDGE_VERSION_STATUS.REVOKED
    );
    expect(assertKnowledgeVersionTransition(KNOWLEDGE_VERSION_STATUS.SUPERSEDED, "REVOKE")).toBe(
      KNOWLEDGE_VERSION_STATUS.REVOKED
    );
    expect(() =>
      assertKnowledgeVersionTransition(KNOWLEDGE_VERSION_STATUS.PUBLISHED, "SUBMIT")
    ).toThrowError(
      expect.objectContaining({ code: "KNOWLEDGE_VERSION_TRANSITION_INVALID", status: 409 })
    );
  });

  it("requires both the global knowledge permission and the source-project read grant", () => {
    expect(() =>
      assertKnowledgeSourceRead({
        knowledgePermissionAllowed: true,
        sourceProjectReadAllowed: false
      })
    ).toThrowError(
      expect.objectContaining({ code: "KNOWLEDGE_SOURCE_READ_FORBIDDEN", status: 403 })
    );
    expect(() =>
      assertKnowledgeSourceRead({
        knowledgePermissionAllowed: false,
        sourceProjectReadAllowed: true
      })
    ).toThrowError(
      expect.objectContaining({ code: "KNOWLEDGE_SOURCE_READ_FORBIDDEN", status: 403 })
    );
    expect(() =>
      assertKnowledgeSourceRead({
        knowledgePermissionAllowed: true,
        sourceProjectReadAllowed: true
      })
    ).not.toThrow();
  });
});
