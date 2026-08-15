import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RetrospectivePageClient } from "./retrospective-page-client";

const base = {
  projectId: "project-1",
  status: "NORMAL" as const,
  allowedActions: ["CREATE", "SUBMIT", "REVIEW", "GENERATE_ARCHIVE_B", "RUN_G9", "CLOSE_PROJECT"],
  archiveA: {
    id: "archive-a",
    status: "READY",
    manifestChecksum: "a-manifest",
    sourceWatermark: "a-source",
    retrospectiveInputWatermark: "a-input"
  },
  archiveB: {
    id: "archive-b",
    status: "READY",
    manifestChecksum: "b-manifest",
    sourceWatermark: "b-source",
    retrospectiveInputWatermark: "b-input"
  },
  currentVersion: { id: "current", status: "IN_REVIEW" },
  latestApprovedVersion: { id: "approved", status: "APPROVED" },
  g9Approval: null,
  projectStatus: "ACTIVE" as const
};

describe("RetrospectivePageClient", () => {
  it("renders exact server-provided governance facts, stale pointer and blockers without inferring closure eligibility", () => {
    const markup = renderToStaticMarkup(
      createElement(RetrospectivePageClient, { projectId: "project-1", initialState: base })
    );
    expect(markup).toContain('data-state="NORMAL"');
    expect(markup).toContain("a-manifest");
    expect(markup).toContain("b-source");
    expect(markup).toContain("当前版本与已批准版本不一致");
    expect(markup).toContain("G9 尚未获得批准");
    expect(markup).toContain("创建复盘");
    expect(markup).toContain("提交复盘");
    expect(markup).toContain("审核复盘");
    expect(markup).not.toContain("关闭项目</button>");
  });

  it.each(["LOADING", "EMPTY", "ERROR", "DENIED", "STALE"] as const)(
    "renders an accessible %s state",
    (status) => {
      const markup = renderToStaticMarkup(
        createElement(RetrospectivePageClient, {
          projectId: "project-1",
          initialState: {
            ...base,
            status,
            allowedActions: [],
            archiveA: status === "EMPTY" ? base.archiveA : null,
            archiveB: null,
            currentVersion: null,
            latestApprovedVersion: null
          }
        })
      );
      expect(markup).toContain(`data-state="${status}"`);
      expect(markup).toMatch(/role="(status|alert)"/);
    }
  );

  it("suppresses write controls on closed projects while retaining an explanatory status", () => {
    const markup = renderToStaticMarkup(
      createElement(RetrospectivePageClient, {
        projectId: "project-1",
        initialState: { ...base, projectStatus: "CLOSED" }
      })
    );
    expect(markup).toContain("项目已关闭，复盘事实不可再修改。");
    expect(markup).not.toContain("提交复盘</button>");
  });
});
