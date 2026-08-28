import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  buildCockpitDashboardPageState,
  developmentCockpitDashboardFixture
} from "@/modules/cockpit/contracts/cockpit-dashboard-page-state";

import { CockpitDashboardContent } from "./cockpit-page-client";

const projectId = "project-1";

function normalState() {
  const sources = developmentCockpitDashboardFixture(projectId, "normal", "development");
  if (!sources) throw new Error("expected development fixture");
  return buildCockpitDashboardPageState(sources);
}

describe("CockpitDashboardContent", () => {
  it("renders summary-first overview structure from the page state", () => {
    const markup = renderToStaticMarkup(
      createElement(CockpitDashboardContent, {
        projectId,
        state: normalState(),
        view: "overview",
        risk: null,
        onRetry: () => undefined
      })
    );

    expect(markup).toContain('class="cockpit-context-band"');
    expect(markup).toContain('class="cockpit-exception-list"');
    expect(markup).toContain("派生健康度");
    expect(markup).toContain("Gate G1 存在硬失败检查项");
    expect(markup).toContain("项目进度");
  });

  it("renders progress and risks as real views without source writes", () => {
    const state = normalState();
    const progressMarkup = renderToStaticMarkup(
      createElement(CockpitDashboardContent, {
        projectId,
        state,
        view: "progress",
        risk: null,
        onRetry: () => undefined
      })
    );
    const riskMarkup = renderToStaticMarkup(
      createElement(CockpitDashboardContent, {
        projectId,
        state,
        view: "risks",
        risk: "HIGH:HIGH",
        onRetry: () => undefined
      })
    );

    expect(progressMarkup).toContain("基线");
    expect(progressMarkup).toContain("当前预测");
    expect(progressMarkup).toContain("实际事实");
    expect(riskMarkup).toContain('class="cockpit-risk-matrix"');
    expect(riskMarkup).toContain('class="cockpit-risk-list"');
    expect(riskMarkup).toContain("HIGH / HIGH");
    expect((riskMarkup.match(/HIGH \/ HIGH/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(riskMarkup).toContain('aria-label="HIGH / HIGH 风险 1 条"');
    expect(riskMarkup).toContain("严重问题");
    expect(riskMarkup).toContain("逾期问题");
    expect(riskMarkup).toContain("/projects/project-1/issues");
  });

  it("renders page-level denied and retryable states explicitly", () => {
    const deniedMarkup = renderToStaticMarkup(
      createElement(CockpitDashboardContent, {
        projectId,
        state: { kind: "denied" },
        view: "overview",
        risk: null,
        onRetry: () => undefined
      })
    );
    const retryMarkup = renderToStaticMarkup(
      createElement(CockpitDashboardContent, {
        projectId,
        state: { kind: "error", message: "服务暂不可用。", retryable: true },
        view: "overview",
        risk: null,
        onRetry: () => undefined
      })
    );

    expect(deniedMarkup).toContain("无权查看项目驾驶舱");
    expect(retryMarkup).toContain("重新加载");
    expect(retryMarkup).toContain("服务暂不可用。");
  });
});
