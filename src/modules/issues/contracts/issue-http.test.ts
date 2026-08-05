import { describe, expect, it } from "vitest";

import {
  parseIssueCreatePayload,
  parseIssueListQuery,
  parseIssueRelationClosePayload,
  parseIssueRelationPayload,
  parseIssueResponsibilityPayload,
  parseIssueTransitionPayload,
  parseIssueUpdatePayload
} from "./issue-http";

describe("APM-070 issue HTTP contracts", () => {
  const details = {
    title: "干涉问题",
    confirmedText: "确认文字是问题事实来源。",
    category: "FUNCTION",
    severity: "HIGH",
    phenomenonDescription: "夹具干涉。",
    rootCauseCategory: "DESIGN",
    rootCauseDescription: "公差未预留。",
    tags: ["干涉"]
  };

  it("accepts a strict project issue create payload", () => {
    expect(parseIssueCreatePayload(details)).toEqual(details);
  });

  it("requires both root-cause fields together on updates", () => {
    expect(() =>
      parseIssueUpdatePayload({
        ...details,
        version: 1,
        reason: "补充分析。",
        rootCauseDescription: null
      })
    ).toThrow();
  });

  it("requires evidence only when closing after verification", () => {
    expect(() =>
      parseIssueTransitionPayload({
        version: 1,
        action: "VERIFY_CLOSE",
        reason: "验证关闭。",
        verificationEvidence: null
      })
    ).toThrow();
    expect(
      parseIssueTransitionPayload({
        version: 1,
        action: "VERIFY_CLOSE",
        reason: "验证关闭。",
        verificationEvidence: "FAT-01 运行记录。"
      })
    ).toMatchObject({ action: "VERIFY_CLOSE" });
  });

  it("uses a bounded cursor query for issue lists", () => {
    expect(parseIssueListQuery(new URL("http://localhost/issues?limit=25&cursor=issue-1"))).toEqual(
      {
        limit: 25,
        cursor: "issue-1"
      }
    );
    expect(parseIssueListQuery(new URL("http://localhost/issues"))).toEqual({
      limit: 50,
      cursor: undefined
    });
  });

  it("accepts a day-granularity responsibility assignment and strict typed relation", () => {
    expect(
      parseIssueResponsibilityPayload({
        version: 2,
        ownerMembershipId: "member-owner",
        verifierMembershipId: "member-verifier",
        dueDate: "2026-08-05",
        reason: "安排整改与独立验证。"
      })
    ).toMatchObject({ dueDate: "2026-08-05" });
    expect(
      parseIssueRelationPayload({
        version: 2,
        relationType: "GATE_INSTANCE",
        targetId: "gate-1",
        reason: "关联放行 Gate。"
      })
    ).toMatchObject({ relationType: "GATE_INSTANCE" });
    expect(() =>
      parseIssueRelationPayload({
        version: 2,
        relationType: "UNKNOWN",
        targetId: "gate-1",
        reason: "错误类型。"
      })
    ).toThrow();
    expect(() =>
      parseIssueRelationClosePayload({ version: 2, reason: "关闭关联。", extra: true })
    ).toThrow();
  });
});
