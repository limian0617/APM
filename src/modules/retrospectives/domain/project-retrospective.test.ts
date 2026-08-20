import { describe, expect, it } from "vitest";

import {
  RETROSPECTIVE_STATUS,
  RetrospectiveDomainError,
  assertRetrospectiveVersionTransition,
  buildRetrospectiveContentSnapshot,
  canUseRetrospectiveForClosure,
  validateRetrospectiveContribution,
  validateRetrospectiveContent
} from "./project-retrospective";

const content = {
  deliverySummary: { summary: "交付范围与实际结果" },
  successfulPractices: { practices: ["先行验证接口"] },
  shortcomings: { items: ["试运行窗口偏短"] },
  improvements: { actions: ["增加复测窗口"] },
  knowledgeDisposition: { disposition: "PUBLISH_CANDIDATE" },
  ipDeclaration: { customerOwned: true, sanitized: true, excludedFields: ["客户姓名"] }
} as const;

describe("project retrospective domain", () => {
  it("requires all seven retrospective content groups and returns a deterministic checksum", () => {
    expect(validateRetrospectiveContent(content)).toEqual(content);
    const first = buildRetrospectiveContentSnapshot({
      ...content,
      projectSnapshot: { id: "p", code: "P", name: "项目", type: "CUSTOMER_DELIVERY" },
      contributions: [],
      participants: [],
      issueSources: []
    });
    const second = buildRetrospectiveContentSnapshot({
      issueSources: [],
      participants: [],
      contributions: [],
      projectSnapshot: { type: "CUSTOMER_DELIVERY", name: "项目", code: "P", id: "p" },
      ...content
    });
    expect(first.contentChecksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.contentChecksum).toBe(first.contentChecksum);
    expect(first.snapshot).toEqual(second.snapshot);
  });

  it("rejects missing content, unscoped contributions, and blank review reasons", () => {
    expect(() => validateRetrospectiveContent({ ...content, shortcomings: null })).toThrowError(
      expect.objectContaining<Partial<RetrospectiveDomainError>>({
        code: "RETROSPECTIVE_REQUIRED_CONTENT_MISSING"
      })
    );
    expect(() =>
      validateRetrospectiveContribution({
        scopeType: "DELIVERY_UNIT",
        deliveryUnitId: null,
        discipline: "机械",
        contributorMembershipId: "member-1",
        factText: "事实",
        impactText: "影响",
        reusable: true,
        required: true
      })
    ).toThrowError(
      expect.objectContaining<Partial<RetrospectiveDomainError>>({
        code: "RETROSPECTIVE_DELIVERY_UNIT_REQUIRED"
      })
    );
  });

  it("enforces immutable version state transitions and independent review", () => {
    expect(assertRetrospectiveVersionTransition("DRAFT", "SUBMIT")).toBe("IN_REVIEW");
    expect(assertRetrospectiveVersionTransition("IN_REVIEW", "APPROVE")).toBe("APPROVED");
    expect(assertRetrospectiveVersionTransition("IN_REVIEW", "REJECT")).toBe("REJECTED");
    expect(() => assertRetrospectiveVersionTransition("APPROVED", "SUBMIT")).toThrowError(
      expect.objectContaining({ code: "RETROSPECTIVE_VERSION_IMMUTABLE" })
    );
    expect(() =>
      assertRetrospectiveVersionTransition("IN_REVIEW", "APPROVE", {
        submitterId: "user-1",
        reviewerId: "user-1"
      })
    ).toThrowError(expect.objectContaining({ code: "RETROSPECTIVE_INDEPENDENT_REVIEW_REQUIRED" }));
  });

  it("allows closure only for the approved current version and its READY Archive B", () => {
    expect(
      canUseRetrospectiveForClosure({
        currentVersionId: "v2",
        latestApprovedVersionId: "v2",
        versionId: "v2",
        status: RETROSPECTIVE_STATUS.APPROVED,
        archiveBStatus: "READY",
        archiveBIntegrityStatus: "PASSED"
      })
    ).toBe(true);
    expect(
      canUseRetrospectiveForClosure({
        currentVersionId: "v3",
        latestApprovedVersionId: "v2",
        versionId: "v2",
        status: RETROSPECTIVE_STATUS.APPROVED,
        archiveBStatus: "READY",
        archiveBIntegrityStatus: "PASSED"
      })
    ).toBe(false);
  });
});
