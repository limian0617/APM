import { describe, expect, it } from "vitest";

import { issueDetailStateLabel } from "./issue-detail-page-client";

describe("project issue detail page", () => {
  it("keeps stable loading, ready and denied state labels", () => {
    expect(issueDetailStateLabel("loading")).toBe("问题读取中");
    expect(issueDetailStateLabel("ready")).toBe("问题详情");
    expect(issueDetailStateLabel("denied")).toBe("无权查看问题");
    expect(issueDetailStateLabel("error")).toBe("问题读取暂时不可用");
  });
});
