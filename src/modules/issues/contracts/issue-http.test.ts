import { describe, expect, it } from "vitest";

import {
  parseIssueCreatePayload,
  parseIssueListQuery,
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
});
