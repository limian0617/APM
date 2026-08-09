import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AcceptancePageDataState } from "@/modules/acceptance/contracts/acceptance-page-state";

import { AcceptancePageContent } from "./acceptance-page-client";

const projectId = "project-1";

function readyState(): AcceptancePageDataState {
  return {
    projectId,
    status: "ready",
    templates: [
      {
        id: "template-v1",
        acceptanceType: "FAT",
        version: 1,
        template: { code: "FAT.BASE", name: "FAT 基础模板" },
        items: [{ id: "item-1" }]
      }
    ],
    batches: [
      {
        id: "batch-1",
        projectId,
        acceptanceType: "FAT",
        scopeType: "MACHINE",
        scopeId: "machine-1",
        status: "IN_PROGRESS",
        version: 2,
        allowedActions: ["RECORD_RESULT", "REVISE_RESULT", "LOCK_BATCH"]
      }
    ],
    batchDetail: {
      batch: {
        id: "batch-1",
        projectId,
        acceptanceType: "FAT",
        status: "IN_PROGRESS",
        version: 2,
        templateVersion: {
          items: [
            {
              id: "item-1",
              code: "POWER",
              name: "通电检查",
              unit: "V",
              required: true,
              evidenceRequired: true
            }
          ]
        },
        results: [
          {
            itemId: "item-1",
            revisions: [
              { id: "revision-1", decision: "PASS", measuredValue: "230V", measuredUnit: "V" }
            ]
          }
        ]
      },
      summary: { passRate: 1, outcome: "PASS", denominator: 1 },
      allowedActions: ["RECORD_RESULT", "REVISE_RESULT", "LOCK_BATCH"]
    },
    timestamps: {
      templates: "2026-08-09T01:00:00.000Z",
      batches: "2026-08-09T02:00:00.000Z",
      batchDetail: "2026-08-09T03:00:00.000Z"
    }
  };
}

describe("AcceptancePageContent", () => {
  it("renders FAT/SAT templates, project-scoped batches, items and append-only result facts", () => {
    const markup = renderToStaticMarkup(
      createElement(AcceptancePageContent, {
        projectId,
        state: readyState(),
        selectedBatchId: "batch-1",
        onRetry: () => undefined
      })
    );
    expect(markup).toContain('class="acceptance-page"');
    expect(markup).toContain("FAT/SAT 验收");
    expect(markup).toContain("FAT 基础模板");
    expect(markup).toContain("版本 1");
    expect(markup).toContain("MACHINE");
    expect(markup).toContain("通电检查");
    expect(markup).toContain("PASS");
    expect(markup).toContain("230V");
    expect(markup).toContain("单位：V");
    expect(markup).toContain('href="/projects/project-1/acceptance?batch=batch-1"');
  });

  it("renders explicit loading, empty, denied, retryable error and stale states", () => {
    const loading = renderToStaticMarkup(
      createElement(AcceptancePageContent, {
        projectId,
        state: { projectId, status: "loading" },
        selectedBatchId: null,
        onRetry: () => undefined
      })
    );
    const empty = renderToStaticMarkup(
      createElement(AcceptancePageContent, {
        projectId,
        state: {
          projectId,
          status: "empty",
          timestamps: { templates: null, batches: null, batchDetail: null }
        },
        selectedBatchId: null,
        onRetry: () => undefined
      })
    );
    const denied = renderToStaticMarkup(
      createElement(AcceptancePageContent, {
        projectId,
        state: { projectId, status: "denied" },
        selectedBatchId: null,
        onRetry: () => undefined
      })
    );
    const error = renderToStaticMarkup(
      createElement(AcceptancePageContent, {
        projectId,
        state: { projectId, status: "error", retryable: true },
        selectedBatchId: null,
        onRetry: () => undefined
      })
    );
    const stale = renderToStaticMarkup(
      createElement(AcceptancePageContent, {
        projectId,
        state: { ...readyState(), status: "stale" },
        selectedBatchId: null,
        onRetry: () => undefined
      })
    );
    expect(loading).toContain("验收数据加载中");
    expect(empty).toContain("暂无 FAT/SAT 验收模板或批次");
    expect(denied).toContain("无权查看项目 FAT/SAT 验收");
    expect(error).toContain("重新加载");
    expect(stale).toContain("数据已过期");
  });

  it("keeps an allowed development fixture on a project-local batch drilldown", () => {
    const markup = renderToStaticMarkup(
      createElement(AcceptancePageContent, {
        projectId,
        state: readyState(),
        selectedBatchId: "batch-1",
        fixture: "normal",
        onRetry: () => undefined
      })
    );
    expect(markup).toContain(
      'href="/projects/project-1/acceptance?batch=batch-1&amp;fixture=normal"'
    );
  });
});
