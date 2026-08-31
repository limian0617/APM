import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  toAnalysisView,
  type UphAnalysisSnapshotDto,
  type UphBatchSummary,
  type UphRevisionSummary
} from "@/modules/uph/contracts/uph-analysis-page-state";

import {
  fetchUphAnalysisDetail,
  fetchUphBatchState,
  fetchUphPageState,
  formatAnalysisCreatedAt,
  UphAnalysisDashboardContent,
  type UphPageState
} from "./uph-page-client";

const batches: UphBatchSummary[] = [
  {
    id: "batch-1",
    batchNumber: "UPH-001",
    currentWorkRevisionId: "revision-1",
    currentLockedRevisionId: "revision-1",
    resourceVersion: 1
  }
];
const revision: UphRevisionSummary = {
  id: "revision-1",
  projectId: "project-1",
  batchId: "batch-1",
  revisionNumber: 2,
  status: "LOCKED",
  resourceVersion: 1,
  topologyRootNodeId: "root",
  topologyVersionId: "topology-1",
  formulaVersionId: "formula-1",
  processOwnerUserId: "user-1",
  pmConfirmerUserId: "user-2",
  qualityLockerUserId: "user-3",
  moduleBindings: [
    { id: "binding-1", projectModuleId: "module-1", ctDefinitionId: "ct-1", ctVersionId: "ctv-1" }
  ]
};
const snapshot: UphAnalysisSnapshotDto = {
  analysisId: "analysis-1",
  projectId: "project-1",
  batchId: "batch-1",
  revisionId: "revision-1",
  lockedChecksum: "a".repeat(64),
  formulaVersionId: "formula-1",
  formulaChecksum: "b".repeat(64),
  engineCode: "UPH_ANALYSIS@1",
  status: "COMPUTED",
  warnings: [],
  rootMeasuredCapacityUph: "120.000000",
  actualGoodUph: "90.000000",
  a: "0.900000",
  resourceVersion: 1,
  createdById: "user-1",
  createdAt: "2026-08-31T10:00:00.000Z",
  inputSnapshot: { bindings: [{ validSampleCount: "10", p90Seconds: "30.000000" }] },
  resultSnapshot: {
    moduleFpy: [{ moduleId: "module-1", fpy: "0.900000" }],
    bottleneck: [
      {
        sourceType: "PROJECT_MODULE",
        sourceId: "module-1",
        relation: "LEAF",
        capacityUph: "120.000000",
        members: []
      }
    ],
    secondBottleneck: null,
    reductionLevels: []
  }
};

function render(state: UphPageState) {
  return renderToStaticMarkup(
    createElement(UphAnalysisDashboardContent, {
      projectId: "project-1",
      state,
      onRetry: () => undefined,
      onSelectBatch: () => undefined,
      onSelectAnalysis: () => undefined
    })
  );
}

describe("UPH page states", () => {
  it("formats only valid createdAt strings", () => {
    expect(formatAnalysisCreatedAt(null)).toBe("无数据");
    expect(formatAnalysisCreatedAt(123)).toBe("无数据");
    expect(formatAnalysisCreatedAt(" ")).toBe("无数据");
    expect(formatAnalysisCreatedAt("not-a-date")).toBe("无数据");
    expect(formatAnalysisCreatedAt("2026-02-30T10:00:00.000Z")).toBe("无数据");
    expect(formatAnalysisCreatedAt("2026-08-31T10:00:00.000Z")).not.toBe("无数据");
  });
  it("covers loading, empty, denied, failure, no locked and no analysis", () => {
    expect(render({ kind: "loading" })).toContain("UPH数据加载中");
    expect(render({ kind: "empty" })).toContain("暂无测试批次");
    expect(render({ kind: "denied" })).toContain("无权查看UPH分析");
    expect(render({ kind: "error", message: "读取失败", retryable: true })).toContain("重新加载");
    expect(render({ kind: "no-locked", batches, selectedBatchId: "batch-1" })).toContain(
      "暂无当前 LOCKED 修订"
    );
    expect(
      render({ kind: "no-analysis", batches, selectedBatchId: "batch-1", revision })
    ).toContain("尚未生成分析");
    expect(
      render({ kind: "partial", batches, selectedBatchId: "batch-1", revision: null, analyses: [] })
    ).toContain("正在读取分析快照");
  });

  it("presents populated metrics, FPY, bottleneck and provenance without write controls", () => {
    const markup = render({
      kind: "populated",
      batches,
      selectedBatchId: "batch-1",
      revision,
      analyses: [snapshot],
      selectedAnalysisId: "analysis-1",
      analysis: toAnalysisView(snapshot)
    });
    expect(markup).toContain("实际良品 UPH");
    expect(markup).toContain("90.000000");
    expect(markup).toContain("实测能力 UPH");
    expect(markup).toContain("模块 FPY");
    expect(markup).toContain("瓶颈");
    expect(markup).toContain("公式checksum");
    expect(markup).not.toContain("生成分析");
    expect(markup).not.toContain("POST");
  });

  it("renders parallel reduction levels and bottleneck transfer details when supplied", () => {
    const hierarchical = {
      ...snapshot,
      resultSnapshot: {
        ...(snapshot.resultSnapshot as Record<string, unknown>),
        reductionLevels: [
          {
            nodeId: "root",
            topologyPath: "root/parallel",
            sourceType: "TOPOLOGY_ROOT",
            sourceId: "line-1",
            selectedCapacityUph: "240.000000",
            candidates: [
              {
                sourceType: "PARALLEL_GROUP",
                sourceId: "group-1",
                relation: "PARALLEL",
                capacityUph: "240.000000",
                members: [{ sourceId: "module-1" }, { sourceId: "module-2" }]
              }
            ]
          },
          {
            nodeId: "module-1",
            topologyPath: "root/parallel/module-1",
            sourceType: "PROJECT_MODULE",
            sourceId: "module-1",
            selectedCapacityUph: "120.000000",
            candidates: []
          }
        ]
      }
    };
    const markup = render({
      kind: "populated",
      batches,
      selectedBatchId: "batch-1",
      revision,
      analyses: [hierarchical],
      selectedAnalysisId: "analysis-1",
      analysis: toAnalysisView(hierarchical)
    });
    expect(markup).toContain("能力归约");
    expect(markup).toContain("并行成员：module-1、module-2");
    expect(markup).toContain("模块 CT 与瓶颈转移");
  });

  it("renders missing and corrupt snapshot fields as 无数据", () => {
    const corrupt = {
      ...snapshot,
      analysisId: "analysis-corrupt",
      createdAt: "2026-02-30T10:00:00.000Z",
      createdById: 42,
      rootMeasuredCapacityUph: { value: 120 },
      actualGoodUph: null,
      a: undefined,
      warnings: { unexpected: true },
      inputSnapshot: { bindings: [{ projectModuleId: "module-1" }] },
      resultSnapshot: {
        moduleFpy: [{ moduleId: "module-1", fpy: { value: 0.9 } }],
        bottleneck: [{ sourceType: "PROJECT_MODULE", sourceId: "module-1" }],
        secondBottleneck: [{ sourceType: "PROJECT_MODULE", sourceId: "module-2" }],
        reductionLevels: [{ nodeId: "root" }]
      }
    } as unknown as UphAnalysisSnapshotDto;
    const markup = render({
      kind: "populated",
      batches,
      selectedBatchId: "batch-1",
      revision,
      analyses: [corrupt],
      selectedAnalysisId: "analysis-corrupt",
      analysis: toAnalysisView(corrupt)
    });
    expect(markup).toContain("无数据");
    expect(markup).not.toContain("[object Object]");
    expect(markup).toContain("analysis-corrupt");
  });

  it("renders SUPERSEDED analysis as explicitly read-only", () => {
    const superseded = { ...revision, status: "SUPERSEDED" };
    const markup = render({
      kind: "populated",
      batches,
      selectedBatchId: "batch-1",
      revision: superseded,
      analyses: [snapshot],
      selectedAnalysisId: "analysis-1",
      analysis: toAnalysisView(snapshot)
    });
    expect(markup).toContain("该修订已被后续版本替代，历史分析快照仍可读取");
    expect(markup).toContain("只读");
  });
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function fetcherFrom(sequence: Array<{ body: unknown; status?: number }>) {
  const calls: Array<{ url: string; method: string }> = [];
  let index = 0;
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    const next = sequence[index++];
    if (!next) throw new Error("unexpected fetch");
    return response(next.body, next.status ?? 200);
  };
  return { fetcher, calls };
}

describe("UPH page GET fetch contract", () => {
  it("loads batches, currentLocked revision, list and detail with GET only", async () => {
    const fixture = fetcherFrom([
      { body: { batches } },
      { body: revision },
      { body: { items: [snapshot], nextCursor: null } },
      { body: snapshot }
    ]);
    const state = await fetchUphPageState("project-1", fixture.fetcher);
    expect(state.kind).toBe("populated");
    expect(fixture.calls.map((call) => call.method)).toEqual(["GET", "GET", "GET", "GET"]);
    expect(fixture.calls[1]?.url).toBe(
      "/api/projects/project-1/uph/test-batches/batch-1?selection=currentLocked"
    );
    expect(fixture.calls[2]?.url).toContain("/analyses");
    expect(fixture.calls[3]?.url).toContain("/analyses/analysis-1");
  });

  it("maps 404 currentLocked to no-locked without leaking metadata", async () => {
    const fixture = fetcherFrom([{ body: { batches }, status: 404 }]);
    const state = await fetchUphBatchState("project-1", "batch-1", batches, fixture.fetcher);
    expect(state).toEqual({ kind: "no-locked", batches, selectedBatchId: "batch-1" });
    expect(JSON.stringify(state)).not.toContain("module-1");
  });

  it("maps an empty list to no-analysis and preserves superseded read-only state", async () => {
    const superseded = { ...revision, status: "SUPERSEDED" };
    const fixture = fetcherFrom([{ body: superseded }, { body: { items: [] } }]);
    const state = await fetchUphBatchState("project-1", "batch-1", batches, fixture.fetcher);
    expect(state.kind).toBe("no-analysis");
    if (state.kind === "no-analysis") expect(state.revision.status).toBe("SUPERSEDED");
  });

  it("maps 403 and read failures to safe retryable states", async () => {
    const denied = fetcherFrom([{ body: { message: "forbidden" }, status: 403 }]);
    const deniedState = await fetchUphPageState("project-1", denied.fetcher);
    expect(deniedState).toEqual({ kind: "denied" });
    expect(JSON.stringify(deniedState)).not.toContain("batch-1");
    const failed = fetcherFrom([{ body: { message: "temporary failure" }, status: 500 }]);
    const failedState = await fetchUphPageState("project-1", failed.fetcher);
    expect(failedState).toEqual({ kind: "error", message: "temporary failure", retryable: true });

    const retryFixture = fetcherFrom([
      { body: { message: "temporary failure" }, status: 500 },
      { body: { batches: [] } }
    ]);
    expect((await fetchUphPageState("project-1", retryFixture.fetcher)).kind).toBe("error");
    expect((await fetchUphPageState("project-1", retryFixture.fetcher)).kind).toBe("empty");
  });

  it("maps 401 from a revision read to denied without leaking source metadata", async () => {
    const fixture = fetcherFrom([{ body: { message: "unauthorized" }, status: 401 }]);
    const state = await fetchUphBatchState("project-1", "batch-1", batches, fixture.fetcher);
    expect(state).toEqual({ kind: "denied" });
    expect(JSON.stringify(state)).not.toContain("revision-1");
    expect(JSON.stringify(state)).not.toContain("module-1");
  });

  it("supports analysis detail switching without changing the read-only GET path", async () => {
    const second = { ...snapshot, analysisId: "analysis-2", status: "NO_OUTPUT" };
    const fixture = fetcherFrom([{ body: second }]);
    const detail = await fetchUphAnalysisDetail(
      "project-1",
      "batch-1",
      "revision-1",
      "analysis-2",
      fixture.fetcher
    );
    expect(detail.id).toBe("analysis-2");
    expect(fixture.calls).toEqual([
      {
        method: "GET",
        url: "/api/projects/project-1/uph/test-batches/batch-1/revisions/revision-1/analyses/analysis-2"
      }
    ]);
  });

  it("supports selecting a different batch through the same currentLocked GET contract", async () => {
    const batchTwo = {
      ...batches[0]!,
      id: "batch-2",
      batchNumber: "UPH-002",
      currentLockedRevisionId: null
    };
    const revisionTwo = { ...revision, id: "revision-2", batchId: "batch-2", status: "SUPERSEDED" };
    const fixture = fetcherFrom([{ body: revisionTwo }, { body: { items: [] } }]);
    const state = await fetchUphBatchState(
      "project-1",
      "batch-2",
      [batches[0]!, batchTwo],
      fixture.fetcher
    );
    expect(state.kind).toBe("no-analysis");
    expect(fixture.calls[0]?.url).toBe(
      "/api/projects/project-1/uph/test-batches/batch-2?selection=currentLocked"
    );
  });
});
