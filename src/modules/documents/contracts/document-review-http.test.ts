import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import {
  createDocumentReviewBodySchema,
  createDocumentReviewCommentBodySchema,
  createDocumentVersionRelationBodySchema,
  decideDocumentReviewBodySchema,
  resolveDocumentReviewCommentBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

describe("APM-051 document review HTTP contracts", () => {
  it("parses strict review, comment, resolution, and relation commands", () => {
    expect(
      parseDto(
        createDocumentReviewBodySchema,
        { version: 2, reviewerId: "reviewer-1", required: true, reason: "请质量人员评审设计版本" },
        "body"
      )
    ).toEqual({
      version: 2,
      reviewerId: "reviewer-1",
      required: true,
      reason: "请质量人员评审设计版本"
    });
    expect(
      parseDto(
        decideDocumentReviewBodySchema,
        { version: 1, status: "CHANGES_REQUESTED", reason: "需要补充安全联锁说明" },
        "body"
      )
    ).toEqual({ version: 1, status: "CHANGES_REQUESTED", reason: "需要补充安全联锁说明" });
    expect(
      parseDto(
        createDocumentReviewCommentBodySchema,
        { body: "补充安全联锁说明", required: true, reason: "记录必要评审意见" },
        "body"
      )
    ).toEqual({ body: "补充安全联锁说明", required: true, reason: "记录必要评审意见" });
    expect(
      parseDto(
        resolveDocumentReviewCommentBodySchema,
        { resolution: "已在第 3 节补充", reason: "确认意见闭环" },
        "body"
      )
    ).toEqual({ resolution: "已在第 3 节补充", reason: "确认意见闭环" });
    expect(
      parseDto(
        createDocumentVersionRelationBodySchema,
        { version: 3, targetType: "GATE_INSTANCE", targetId: "gate-1", reason: "此版本用于 G2" },
        "body"
      )
    ).toEqual({
      version: 3,
      targetType: "GATE_INSTANCE",
      targetId: "gate-1",
      reason: "此版本用于 G2"
    });
  });

  it("rejects loose review and relation command payloads", () => {
    expect(() =>
      parseDto(
        createDocumentReviewBodySchema,
        { version: 0, reviewerId: "reviewer-1", required: "yes", reason: "x", unexpected: true },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        createDocumentVersionRelationBodySchema,
        { version: 1, targetType: "ISSUE", targetId: "issue-1", reason: "越出本工作包范围" },
        "body"
      )
    ).toThrowError(ApiContractError);
  });
});
