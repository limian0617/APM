import { describe, expect, it } from "vitest";

import { issueDetailStateLabel, parseRetestObservationStart } from "./issue-detail-page-client";

describe("project issue detail page", () => {
  it("keeps stable loading, ready and denied state labels", () => {
    expect(issueDetailStateLabel("loading")).toBe("问题读取中");
    expect(issueDetailStateLabel("ready")).toBe("问题详情");
    expect(issueDetailStateLabel("denied")).toBe("无权查看问题");
    expect(issueDetailStateLabel("error")).toBe("问题读取暂时不可用");
  });

  it("rejects invalid datetime-local values before constructing an ISO timestamp", () => {
    expect(parseRetestObservationStart("2026-02-30T10:00")).toBeNull();
    expect(parseRetestObservationStart("2026-09-05T24:00")).toBeNull();
    expect(parseRetestObservationStart("not-a-date")).toBeNull();
    expect(parseRetestObservationStart("2026-09-05T10:30")).toBe("2026-09-05T02:30:00.000Z");
  });
});
