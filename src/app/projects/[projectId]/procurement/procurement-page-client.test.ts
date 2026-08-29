import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  ProcurementDataState,
  ProcurementPageState
} from "@/modules/procurement/contracts/procurement-page-state";
import {
  buildProcurementPageState,
  toProcurementFetchResult
} from "@/modules/procurement/contracts/procurement-page-state";

import {
  createChangeImpactIdempotencyKeyStore,
  idempotencyKeyForChangeImpactResolution,
  ProcurementPageContent
} from "./procurement-page-client";

const projectId = "project-1";

function readyState(): Extract<ProcurementDataState, { status: "ready" }> {
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
      sourceSyncedAt: "2026-08-08T01:00:00.000Z",
      sourceTimestamps: {
        requirements: "2026-08-08T00:00:00.000Z",
        tracking: "2026-08-08T00:30:00.000Z",
        fulfillment: "2026-08-08T01:00:00.000Z",
        changeImpacts: "2026-08-08T01:30:00.000Z",
        readiness: "2026-08-08T02:00:00.000Z"
      }
    },
    readiness: {
      status: "READY",
      scopes: [
        { scopeType: "PROJECT", scopeId: projectId, totalLines: 4, readyLines: 3 },
        { scopeType: "DELIVERY_UNIT", scopeId: "du-1", totalLines: 2, readyLines: 2 },
        { scopeType: "MACHINE", scopeId: "machine-1", totalLines: 2, readyLines: 1 },
        { scopeType: "MODULE", scopeId: "module-1", totalLines: 1, readyLines: 0 },
        { scopeType: "REQUIREMENT", scopeId: "req-1", totalLines: 1, readyLines: 0 }
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
    expect(markup).toContain("需求来源");
    expect(markup).toContain("跟踪来源");
    expect(markup).toContain("履约来源");
    expect(markup).toContain("变更影响来源");
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
    expect(readinessMarkup).toContain("3/4 行");
    expect(readinessMarkup).toContain("2/2 行");
    expect(readinessMarkup).toContain("PROC-READINESS-1");
  });

  it("renders unresolved major-change obligations and a real evidence entry form", () => {
    const state = readyState();
    const markup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state: {
          ...state,
          changeImpacts: {
            status: "ready",
            data: {
              impacts: [
                {
                  id: "impact-1",
                  status: "OPEN",
                  version: 2,
                  requirementId: "req-1",
                  changedFieldsJson: ["quantity"],
                  obligations: [
                    {
                      id: "obligation-1",
                      type: "PROCUREMENT_OWNER",
                      subjectId: "member-1",
                      resolution: null
                    }
                  ]
                }
              ]
            }
          }
        },
        view: "readiness",
        onRetry: () => undefined
      })
    );

    expect(markup).toContain("未处置重大采购变更");
    expect(markup).toContain("PROCUREMENT_OWNER");
    expect(markup).toContain("数量");
    expect(markup).toContain("处置证据");
    expect(markup).toContain("采购负责人已确认");
  });

  it("shows a safe change-impact error instead of an empty result when the optional read fails", () => {
    const ready = readyState();
    const state = buildProcurementPageState({
      projectId,
      overview: toProcurementFetchResult({ status: 200, body: ready.overview }),
      readiness: toProcurementFetchResult({ status: 200, body: ready.readiness }),
      changeImpacts: toProcurementFetchResult({ status: 503 })
    });
    const markup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state,
        view: "readiness",
        onRetry: () => undefined
      })
    );

    expect(markup).toContain("重大采购变更暂时不可用");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).not.toContain("暂无未处置重大采购变更");
  });

  it("announces change-impact loading without rendering an empty count", () => {
    const state: ProcurementDataState = {
      ...readyState(),
      overview: {
        ...readyState().overview,
        changeImpacts: [{ id: "overview-impact", requirementId: "不得显示" }]
      },
      changeImpacts: { status: "loading" }
    };
    const markup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state,
        view: "readiness",
        onRetry: () => undefined
      })
    );

    expect(markup).toContain("重大采购变更加载中");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain("0 项");
    expect(markup).not.toContain("不得显示");
  });

  it("announces restricted change impacts without exposing raw impact, evidence, or owner fields", () => {
    const state: ProcurementDataState = {
      ...readyState(),
      overview: {
        ...readyState().overview,
        changeImpacts: [
          {
            id: "impact-secret-id",
            requirementId: "secret-impact",
            ownerId: "secret-owner",
            evidenceReference: "secret-evidence"
          }
        ]
      },
      changeImpacts: { status: "restricted" }
    };
    const markup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state,
        view: "readiness",
        onRetry: () => undefined
      })
    );

    expect(markup).toContain("重大采购变更区域受限");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain("secret-impact");
    expect(markup).not.toContain("secret-owner");
    expect(markup).not.toContain("secret-evidence");
    expect(markup).not.toContain("impact-secret-id");
  });

  it("renders ready change impacts only from the authorized change-impact response", () => {
    const state: ProcurementDataState = {
      ...readyState(),
      overview: {
        ...readyState().overview,
        changeImpacts: [{ id: "overview-secret", requirementId: "overview-secret" }]
      },
      changeImpacts: {
        status: "ready",
        data: {
          impacts: [
            {
              id: "authorized-impact",
              status: "OPEN",
              version: 1,
              requirementId: "authorized-impact",
              changedFieldsJson: [],
              obligations: []
            }
          ]
        }
      }
    };
    const markup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state,
        view: "readiness",
        onRetry: () => undefined
      })
    );

    expect(markup).toContain("authorized-impact");
    expect(markup).not.toContain("overview-secret");
  });

  it("does not render a stale overview fallback when the current change-impact source is absent", () => {
    const state: ProcurementDataState = {
      ...readyState(),
      overview: {
        ...readyState().overview,
        changeImpacts: [{ id: "stale-overview-impact", requirementId: "stale-overview-impact" }]
      }
    };
    const markup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state,
        view: "readiness",
        onRetry: () => undefined
      })
    );

    expect(markup).toContain("重大采购变更状态尚未确认");
    expect(markup).not.toContain("stale-overview-impact");
  });

  it("builds state from production overview and readiness DTOs before rendering each view", () => {
    const state = buildProcurementPageState({
      projectId,
      overview: toProcurementFetchResult({
        status: 200,
        body: {
          projectId,
          projectName: "生产采购项目",
          projectCode: "APM-090",
          mode: "LOCAL",
          status: "READY",
          overallReadinessRate: "0.75",
          criticalReadinessRate: "0.5",
          criticalGapLines: 1,
          notOrderedCount: 1,
          overdueCount: 1,
          pendingAcceptanceCount: 1,
          changePendingCount: 1,
          blockingCount: 2,
          sourceSyncedAt: "2026-08-08T01:00:00.000Z",
          calculatedAt: "2026-08-08T02:00:00.000Z",
          sourceTimestamps: {
            requirements: "2026-08-08T00:00:00.000Z",
            tracking: "2026-08-08T00:30:00.000Z",
            fulfillment: "2026-08-08T01:00:00.000Z",
            changeImpacts: "2026-08-08T01:30:00.000Z",
            readiness: "2026-08-08T02:00:00.000Z"
          },
          requirements: [{ id: "req-1", name: "伺服电机" }],
          tracking: [{ id: "track-1", status: "ORDERED" }],
          arrivals: [{ id: "arrival-1", eventType: "ACCEPTED" }]
        }
      }),
      readiness: toProcurementFetchResult({
        status: 200,
        body: {
          projectId,
          status: "READY",
          formulaVersion: "PROCUREMENT.READINESS@1",
          inputWatermark: "watermark-1",
          calculatedAt: "2026-08-08T02:00:00.000Z",
          sourceSyncedAt: "2026-08-08T01:00:00.000Z",
          scopes: [{ scopeType: "PROJECT", scopeId: projectId, totalLines: 4, readyLines: 3 }]
        }
      })
    });

    expect(state.status).toBe("ready");
    for (const view of ["overview", "requirements", "tracking", "arrivals", "readiness"] as const) {
      const markup = renderToStaticMarkup(
        createElement(ProcurementPageContent, {
          projectId,
          state,
          view,
          onRetry: () => undefined
        })
      );
      expect(markup).toContain("生产采购项目");
    }
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
    vi.stubEnv("NODE_ENV", "development");
    try {
      const markup = renderToStaticMarkup(
        createElement(ProcurementPageContent, {
          projectId,
          state: readyState(),
          view: "overview",
          fixture: "normal",
          onRetry: () => undefined
        })
      );
      expect(markup).toContain(
        'href="/projects/project-1/procurement?view=requirements&amp;fixture=normal"'
      );
      expect(markup).toContain(
        'href="/projects/project-1/procurement?view=readiness&amp;fixture=normal"'
      );
      expect(markup).not.toContain('href="https://');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reuses an idempotency key for an unchanged obligation and rotates it after form input changes", () => {
    const keys = createChangeImpactIdempotencyKeyStore();
    const input = {
      impactId: "impact-1",
      obligationId: "obligation-1",
      version: 2,
      disposition: "OWNER_PLAN_CONFIRMED",
      evidenceReference: "supplier-email-20260808",
      reason: "采购负责人已确认处置方案"
    };

    const first = idempotencyKeyForChangeImpactResolution(keys, input);
    const retry = idempotencyKeyForChangeImpactResolution(keys, input);
    const changedDisposition = idempotencyKeyForChangeImpactResolution(keys, {
      ...input,
      disposition: "SUPPLIER_ACCEPTED"
    });
    const changedEvidence = idempotencyKeyForChangeImpactResolution(keys, {
      ...input,
      evidenceReference: "supplier-email-20260809"
    });
    const changedReason = idempotencyKeyForChangeImpactResolution(keys, {
      ...input,
      reason: "采购负责人已更新处置方案"
    });

    expect(retry).toBe(first);
    expect(changedDisposition).not.toBe(first);
    expect(changedEvidence).not.toBe(first);
    expect(changedReason).not.toBe(first);
    expect(first).toMatch(/^[A-Za-z0-9-]+$/u);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(191);
  });
});
