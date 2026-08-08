import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  ProcurementDataState,
  ProcurementPageState
} from "@/modules/procurement/contracts/procurement-page-state";

import { ProcurementPageContent } from "./procurement-page-client";

const projectId = "project-1";

function readyState(): ProcurementDataState {
  return {
    projectId,
    status: "ready",
    overview: {
      projectName: "装配线升级项目",
      mode: "LOCAL",
      overallReadinessRate: "0.75",
      criticalReadinessRate: "0.5",
      notOrderedCount: 2,
      overdueCount: 1,
      pendingAcceptanceCount: 1,
      changePendingCount: 1,
      blockingCount: 1,
      sourceSyncedAt: "2026-08-08T01:00:00.000Z"
    },
    readiness: {
      status: "READY",
      scopes: [
        { scopeType: "PROJECT", scopeId: projectId, lineCount: 4, readyLineCount: 3 },
        { scopeType: "DELIVERY_UNIT", scopeId: "du-1", lineCount: 2, readyLineCount: 2 },
        { scopeType: "MACHINE", scopeId: "machine-1", lineCount: 2, readyLineCount: 1 },
        { scopeType: "MODULE", scopeId: "module-1", lineCount: 1, readyLineCount: 0 },
        { scopeType: "REQUIREMENT", scopeId: "req-1", lineCount: 1, readyLineCount: 0 }
      ],
      formulaVersion: "PROC-READINESS-1",
      inputWatermark: "wm-1",
      calculatedAt: "2026-08-08T02:00:00.000Z",
      sourceSyncedAt: "2026-08-08T01:00:00.000Z"
    },
    timestamps: {
      overview: "2026-08-08T01:00:00.000Z",
      readiness: "2026-08-08T01:00:00.000Z"
    }
  };
}

describe("ProcurementPageContent", () => {
  it("renders the operational overview and five view links", () => {
    const markup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state: readyState(),
        view: "overview",
        onRetry: () => undefined
      })
    );
    expect(markup).toContain('class="procurement-page"');
    expect(markup).toContain("装配线升级项目");
    expect(markup).toContain("整体齐套");
    expect(markup).toContain("关键物料齐套");
    expect(markup).toContain("关键缺料");
    expect(markup).toContain("逾期未到");
    expect(markup).toContain("待验收");
    expect(markup).toContain("未下单");
    expect(markup).toContain("变更待处理");
    expect(markup).toContain("阻塞装配");
    expect(markup).toContain("采购总览");
    expect(markup).toContain("采购需求");
    expect(markup).toContain("采购跟踪");
    expect(markup).toContain("到货与验收");
    expect(markup).toContain("齐套与影响");
    expect(markup).toContain("项目本地台账");
    expect(markup).toContain("2026-08-08");
  });

  it("renders tree, tracking, arrivals and readiness content without writes", () => {
    const state = readyState();
    const treeMarkup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state: {
          ...state,
          overview: { ...state.overview, requirements: [{ id: "req-1", name: "伺服电机" }] }
        },
        view: "requirements",
        onRetry: () => undefined
      })
    );
    const trackingMarkup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state: {
          ...state,
          overview: { ...state.overview, tracking: [{ id: "track-1", status: "ORDERED" }] }
        },
        view: "tracking",
        onRetry: () => undefined
      })
    );
    const arrivalsMarkup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state: {
          ...state,
          overview: {
            ...state.overview,
            arrivals: [{ id: "event-1", eventType: "PURCHASE_ARRIVED" }]
          }
        },
        view: "arrivals",
        onRetry: () => undefined
      })
    );
    const readinessMarkup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state,
        view: "readiness",
        onRetry: () => undefined
      })
    );
    expect(treeMarkup).toContain("采购需求树");
    expect(treeMarkup).toContain("伺服电机");
    expect(trackingMarkup).toContain("采购跟踪表");
    expect(trackingMarkup).toContain("ORDERED");
    expect(arrivalsMarkup).toContain("履约时间线");
    expect(arrivalsMarkup).toContain("PURCHASE_ARRIVED");
    expect(readinessMarkup).toContain("树状齐套");
    expect(readinessMarkup).toContain("DELIVERY_UNIT");
    expect(readinessMarkup).toContain("PROC-READINESS-1");
  });

  it("renders page states and restricted supplier areas explicitly", () => {
    const deniedMarkup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state: { projectId, status: "denied" },
        view: "overview",
        onRetry: () => undefined
      })
    );
    const errorMarkup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state: { projectId, status: "error", retryable: true },
        view: "overview",
        onRetry: () => undefined
      })
    );
    const partialState: ProcurementDataState = {
      ...readyState(),
      status: "partial-denied",
      suppliers: { status: "restricted" }
    };
    const partialMarkup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state: partialState,
        view: "overview",
        onRetry: () => undefined
      })
    );
    expect(deniedMarkup).toContain("无权查看项目采购信息");
    expect(errorMarkup).toContain("重新加载");
    expect(partialMarkup).toContain("供应商区域受限");
    expect(partialMarkup).not.toContain("supplierId");
  });

  it("keeps keyboard-visible navigation and project-local drilldown links", () => {
    const markup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state: readyState(),
        view: "overview",
        onRetry: () => undefined
      })
    );
    expect(markup).toContain('href="/projects/project-1/procurement?view=requirements"');
    expect(markup).not.toContain('href="https://');
  });
});
