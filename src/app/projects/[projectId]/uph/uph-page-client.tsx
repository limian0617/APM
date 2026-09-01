"use client";

import { useCallback, useEffect, useState } from "react";

import {
  displayValue,
  statusLabel,
  toAnalysisView,
  type AnalysisCandidateView,
  type AnalysisView,
  type UphAnalysisListDto,
  type UphAnalysisSnapshotDto,
  type UphBatchSummary,
  type UphRevisionSummary
} from "@/modules/uph/contracts/uph-analysis-page-state";

export type UphPageState =
  | { kind: "loading" }
  | { kind: "denied" }
  | { kind: "error"; message: string; retryable: boolean }
  | { kind: "empty" }
  | { kind: "no-locked"; batches: UphBatchSummary[]; selectedBatchId: string }
  | {
      kind: "partial";
      batches: UphBatchSummary[];
      selectedBatchId: string;
      revision: UphRevisionSummary | null;
      analyses: UphAnalysisSnapshotDto[];
    }
  | {
      kind: "no-analysis";
      batches: UphBatchSummary[];
      selectedBatchId: string;
      revision: UphRevisionSummary;
    }
  | {
      kind: "populated";
      batches: UphBatchSummary[];
      selectedBatchId: string;
      revision: UphRevisionSummary;
      analyses: UphAnalysisSnapshotDto[];
      selectedAnalysisId: string;
      analysis: AnalysisView;
    };

type UphPageClientProps = { projectId: string };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type LoadedUphPageState = Exclude<UphPageState, { kind: "loading" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeBatches(payload: unknown): UphBatchSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.batches)) return [];
  return payload.batches.filter(
    (batch): batch is UphBatchSummary =>
      isRecord(batch) && typeof batch.id === "string" && batch.id.trim().length > 0
  );
}

function normalizeSnapshots(payload: unknown): UphAnalysisSnapshotDto[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return [];
  return payload.items.filter(
    (snapshot): snapshot is UphAnalysisSnapshotDto =>
      isRecord(snapshot) &&
      typeof snapshot.analysisId === "string" &&
      snapshot.analysisId.trim().length > 0
  );
}

async function getJson<T>(url: string, fetcher: Fetcher = fetch): Promise<T> {
  const response = await fetcher(url, { method: "GET", headers: { Accept: "application/json" } });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new HttpError(
      response.status,
      isRecord(body) && typeof body.message === "string" ? body.message : "读取UPH数据失败。"
    );
  }
  return body as T;
}

function apiPath(projectId: string, suffix: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/uph${suffix}`;
}

function deniedOrError(error: unknown): Exclude<UphPageState, { kind: "loading" }> {
  if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
    return { kind: "denied" };
  }
  return {
    kind: "error",
    message: error instanceof HttpError ? error.message : "UPH数据暂不可用。",
    retryable: true
  };
}

export function formatAnalysisCreatedAt(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "无数据";
  const input = value.trim();
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})(?:T|\s|$)/.exec(input);
  if (isoDate) {
    const year = Number(isoDate[1]);
    const month = Number(isoDate[2]);
    const day = Number(isoDate[3]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    if (!daysInMonth || day < 1 || day > daysInMonth) return "无数据";
  }
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? "无数据" : date.toLocaleString("zh-CN");
}

export async function fetchUphAnalysisDetail(
  projectId: string,
  batchId: string,
  revisionId: string,
  analysisId: string,
  fetcher: Fetcher = fetch
): Promise<AnalysisView> {
  const detail = await getJson<UphAnalysisSnapshotDto>(
    apiPath(
      projectId,
      `/test-batches/${encodeURIComponent(batchId)}/revisions/${encodeURIComponent(revisionId)}/analyses/${encodeURIComponent(analysisId)}`
    ),
    fetcher
  );
  return toAnalysisView(detail);
}

export async function fetchUphBatchState(
  projectId: string,
  batchId: string,
  batches: UphBatchSummary[],
  fetcher: Fetcher = fetch
): Promise<LoadedUphPageState> {
  let revision: UphRevisionSummary;
  try {
    revision = await getJson<UphRevisionSummary>(
      apiPath(projectId, `/test-batches/${encodeURIComponent(batchId)}?selection=currentLocked`),
      fetcher
    );
    if (!isRecord(revision) || typeof revision.id !== "string" || !revision.id.trim()) {
      throw new Error("UPH修订响应无效。");
    }
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return { kind: "no-locked", batches, selectedBatchId: batchId };
    }
    return deniedOrError(error);
  }

  let list: UphAnalysisListDto;
  try {
    list = await getJson<UphAnalysisListDto>(
      apiPath(
        projectId,
        `/test-batches/${encodeURIComponent(batchId)}/revisions/${encodeURIComponent(revision.id)}/analyses`
      ),
      fetcher
    );
  } catch (error) {
    return deniedOrError(error);
  }
  const snapshots = normalizeSnapshots(list);
  if (snapshots.length === 0) {
    return { kind: "no-analysis", batches, selectedBatchId: batchId, revision };
  }
  const first = snapshots[0]!;
  try {
    const analysis = await fetchUphAnalysisDetail(
      projectId,
      batchId,
      revision.id,
      first.analysisId,
      fetcher
    );
    return {
      kind: "populated",
      batches,
      selectedBatchId: batchId,
      revision,
      analyses: snapshots,
      selectedAnalysisId: first.analysisId,
      analysis
    };
  } catch (error) {
    return deniedOrError(error);
  }
}

export async function fetchUphPageState(
  projectId: string,
  fetcher: Fetcher = fetch
): Promise<LoadedUphPageState> {
  try {
    const payload = await getJson<unknown>(apiPath(projectId, "/test-batches?limit=100"), fetcher);
    const batches = normalizeBatches(payload);
    if (batches.length === 0) return { kind: "empty" };
    const selected = batches.find((batch) => batch.currentLockedRevisionId) ?? batches[0]!;
    return fetchUphBatchState(projectId, selected.id, batches, fetcher);
  } catch (error) {
    return deniedOrError(error);
  }
}

function Metric({
  label,
  value,
  accent
}: {
  label: string;
  value: string | null;
  accent?: boolean;
}) {
  return (
    <div className={`uph-metric${accent ? " uph-metric-accent" : ""}`}>
      <span>{label}</span>
      <strong>{displayValue(value)}</strong>
    </div>
  );
}

function CandidateList({ title, items }: { title: string; items: AnalysisCandidateView[] }) {
  return (
    <section className="uph-candidate-section" aria-label={title}>
      <div className="uph-section-heading">
        <h3>{title}</h3>
        <span>{items.length ? `${items.length}项` : "无数据"}</span>
      </div>
      {items.length ? (
        <ul className="uph-candidate-list">
          {items.map((item) => (
            <li key={`${item.relation}:${item.sourceType}:${item.sourceId}`}>
              <details className="uph-candidate-drilldown">
                <summary className="uph-candidate-summary">
                  <span className="uph-candidate-summary-main">
                    <strong>{item.sourceId}</strong>
                    <span>
                      {item.sourceType} · {item.relation}
                    </span>
                  </span>
                  <span className="uph-candidate-capacity">{item.capacityUph} UPH</span>
                </summary>
                <div className="uph-candidate-drilldown-content">
                  <dl className="uph-candidate-details">
                    <div>
                      <dt>来源类型</dt>
                      <dd>{item.sourceType}</dd>
                    </div>
                    <div>
                      <dt>关系</dt>
                      <dd>{item.relation}</dd>
                    </div>
                    <div>
                      <dt>能力</dt>
                      <dd>{item.capacityUph} UPH</dd>
                    </div>
                  </dl>
                  {item.members.length > 0 ? (
                    <p className="uph-candidate-members">并行成员：{item.members.join("、")}</p>
                  ) : null}
                </div>
              </details>
            </li>
          ))}
        </ul>
      ) : (
        <p className="uph-muted">无数据</p>
      )}
    </section>
  );
}

function TransferDrilldown({ analysis }: { analysis: AnalysisView }) {
  const transfers = analysis.reductionLevels.flatMap((level) =>
    level.candidates.map((candidate) => ({ level, candidate }))
  );
  if (!transfers.length) return null;
  return (
    <section className="uph-card uph-transfer-card" aria-labelledby="uph-transfer-title">
      <div className="uph-section-heading">
        <div>
          <p className="uph-kicker">BOTTLENECK TRANSFER</p>
          <h2 id="uph-transfer-title">瓶颈转移路径</h2>
        </div>
        <span>{transfers.length}项</span>
      </div>
      <div className="uph-transfer-list">
        {transfers.map(({ level, candidate }) => (
          <details
            className="uph-transfer-drilldown"
            key={`${level.nodeId}:${candidate.relation}:${candidate.sourceType}:${candidate.sourceId}`}
          >
            <summary className="uph-transfer-summary">
              <span>{candidate.sourceId}</span>
              <span>
                {candidate.relation} · {candidate.capacityUph} UPH
              </span>
            </summary>
            <div className="uph-transfer-content">
              <dl className="uph-candidate-details">
                <div>
                  <dt>来源层级</dt>
                  <dd>{level.sourceId}</dd>
                </div>
                <div>
                  <dt>拓扑路径</dt>
                  <dd>{level.topologyPath}</dd>
                </div>
                <div>
                  <dt>来源类型</dt>
                  <dd>{candidate.sourceType}</dd>
                </div>
              </dl>
              {candidate.members.length > 0 ? (
                <p className="uph-candidate-members">并行成员：{candidate.members.join("、")}</p>
              ) : null}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function CapacityDrilldown({ analysis }: { analysis: AnalysisView }) {
  const hasHierarchy =
    analysis.reductionLevels.length > 1 ||
    analysis.reductionLevels.some((level) =>
      level.candidates.some((candidate) => candidate.relation !== "LEAF")
    );
  if (!hasHierarchy) {
    return <p className="uph-muted uph-single-machine-note">单机项目无需展开产线层级。</p>;
  }
  return (
    <section className="uph-card" aria-labelledby="uph-capacity-title">
      <div className="uph-section-heading">
        <div>
          <p className="uph-kicker">CAPACITY DRILL-DOWN</p>
          <h2 id="uph-capacity-title">瓶颈与能力归约</h2>
        </div>
        <span>{analysis.reductionLevels.length}层</span>
      </div>
      <div className="uph-reduction-list">
        {analysis.reductionLevels.map((level) => (
          <details className="uph-reduction-level" key={level.nodeId} open>
            <summary className="uph-reduction-level-summary">
              <span className="uph-breakable">{level.sourceId}</span>
              <span>
                {level.selectedCapacityUph} UPH · {level.sourceType}
              </span>
            </summary>
            <div className="uph-reduction-content">
              <p className="uph-meta uph-breakable uph-reduction-path">
                路径：{level.topologyPath}
              </p>
              <CandidateList title="候选与转移" items={level.candidates} />
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function AnalysisDetail({ analysis }: { analysis: AnalysisView }) {
  return (
    <>
      <section className="uph-metric-band" aria-label="UPH核心指标">
        <Metric accent label="实际良品 UPH" value={analysis.actualGoodUph} />
        <Metric label="实测能力 UPH" value={analysis.rootMeasuredCapacityUph} />
        <Metric label="A / 可用率" value={analysis.a} />
        <Metric label="状态" value={statusLabel(analysis.status)} />
      </section>

      <div className="uph-analysis-grid">
        <section className="uph-card" aria-labelledby="uph-fpy-title">
          <div className="uph-section-heading">
            <div>
              <p className="uph-kicker">FIRST PASS YIELD</p>
              <h2 id="uph-fpy-title">模块 FPY</h2>
            </div>
            <span>只读事实</span>
          </div>
          {analysis.moduleFpy.length ? (
            <ul className="uph-fpy-list">
              {analysis.moduleFpy.map((item) => (
                <li key={item.moduleId}>
                  <span className="uph-breakable">{item.moduleId}</span>
                  <strong>{displayValue(item.fpy)}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <p className="uph-muted">无数据</p>
          )}
        </section>

        <section className="uph-card" aria-labelledby="uph-statistics-title">
          <div className="uph-section-heading">
            <h2 id="uph-statistics-title">样本统计</h2>
            <span>冻结快照</span>
          </div>
          <dl className="uph-detail-list">
            <div>
              <dt>有效样本</dt>
              <dd>{displayValue(analysis.statistics.validSampleCount)}</dd>
            </div>
            <div>
              <dt>P50</dt>
              <dd>{displayValue(analysis.statistics.p50Seconds)}</dd>
            </div>
            <div>
              <dt>P90</dt>
              <dd>{displayValue(analysis.statistics.p90Seconds)}</dd>
            </div>
            <div>
              <dt>最大周期</dt>
              <dd>{displayValue(analysis.statistics.maxSeconds)}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="uph-card" aria-labelledby="uph-ct-title">
        <div className="uph-section-heading">
          <div>
            <p className="uph-kicker">MODULE CT</p>
            <h2 id="uph-ct-title">模块 CT 与瓶颈转移</h2>
          </div>
          <span>来源快照</span>
        </div>
        {analysis.moduleCycleTimes.length ? (
          <div className="uph-ct-table-wrap uph-inner-scroll">
            <table className="uph-ct-table">
              <thead>
                <tr>
                  <th>模块</th>
                  <th>固有 CT（秒）</th>
                  <th>P90（秒）</th>
                </tr>
              </thead>
              <tbody>
                {analysis.moduleCycleTimes.map((item) => (
                  <tr key={item.moduleId}>
                    <th scope="row">
                      <details
                        className="uph-ct-drilldown"
                        aria-label={`模块 CT：${item.moduleId}`}
                      >
                        <summary className="uph-breakable">{item.moduleId}</summary>
                        <div className="uph-ct-drilldown-content">
                          <dl className="uph-candidate-details">
                            <div>
                              <dt>固有 CT（秒）</dt>
                              <dd>{displayValue(item.intrinsicCtSeconds)}</dd>
                            </div>
                            <div>
                              <dt>P90（秒）</dt>
                              <dd>{displayValue(item.p90Seconds)}</dd>
                            </div>
                          </dl>
                        </div>
                      </details>
                    </th>
                    <td>{displayValue(item.intrinsicCtSeconds)}</td>
                    <td>{displayValue(item.p90Seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="uph-muted">无数据</p>
        )}
      </section>

      <section className="uph-card" aria-labelledby="uph-bottleneck-title">
        <div className="uph-section-heading">
          <h2 id="uph-bottleneck-title">能力结论</h2>
          <span>可追溯</span>
        </div>
        <div className="uph-bottleneck-grid">
          <CandidateList title="瓶颈" items={analysis.bottleneck} />
          <CandidateList title="第二瓶颈" items={analysis.secondBottleneck} />
        </div>
      </section>

      <CapacityDrilldown analysis={analysis} />

      <TransferDrilldown analysis={analysis} />

      <section className="uph-card" aria-labelledby="uph-provenance-title">
        <div className="uph-section-heading">
          <h2 id="uph-provenance-title">快照来源</h2>
          <span>不可变记录</span>
        </div>
        <dl className="uph-detail-list uph-provenance-list uph-breakable-values">
          <div>
            <dt>分析ID</dt>
            <dd>{analysis.id}</dd>
          </div>
          <div>
            <dt>引擎</dt>
            <dd>{analysis.engineCode}</dd>
          </div>
          <div>
            <dt>公式版本</dt>
            <dd>{analysis.formulaVersionId}</dd>
          </div>
          <div>
            <dt>公式checksum</dt>
            <dd>{analysis.formulaChecksum}</dd>
          </div>
          <div>
            <dt>LOCKED checksum</dt>
            <dd>{analysis.lockedChecksum}</dd>
          </div>
          <div>
            <dt>创建人</dt>
            <dd>{displayValue(analysis.createdById)}</dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{formatAnalysisCreatedAt(analysis.createdAt)}</dd>
          </div>
        </dl>
        <div className="uph-warning-list" aria-label="分析警告">
          {analysis.warnings.length ? (
            analysis.warnings.map((warning) => <span key={warning}>{warning}</span>)
          ) : (
            <span className="uph-muted">无警告</span>
          )}
        </div>
      </section>
    </>
  );
}

export function UphAnalysisDashboardContent({
  projectId,
  state,
  onRetry,
  onSelectBatch,
  onSelectAnalysis
}: {
  projectId: string;
  state: UphPageState;
  onRetry: () => void;
  onSelectBatch?: (batchId: string) => void;
  onSelectAnalysis?: (analysisId: string) => void;
}) {
  if (state.kind === "loading") {
    return (
      <main className="uph-page uph-viewport-safe" aria-busy="true" aria-label="UPH数据加载中">
        <div className="uph-skeleton uph-skeleton-title" />
        <div className="uph-skeleton uph-skeleton-metrics" />
        <div className="uph-skeleton uph-skeleton-panel" />
      </main>
    );
  }
  if (state.kind === "denied") {
    return (
      <main className="uph-page uph-state-page uph-viewport-safe">
        <section className="uph-state-panel">
          <p className="uph-kicker">PROJECT UPH</p>
          <h1>无权查看UPH分析</h1>
          <p>当前身份没有此项目的UPH读取权限。</p>
        </section>
      </main>
    );
  }
  if (state.kind === "error") {
    return (
      <main className="uph-page uph-state-page uph-viewport-safe">
        <section className="uph-state-panel">
          <p className="uph-kicker">PROJECT UPH</p>
          <h1>UPH数据暂不可用</h1>
          <p>{state.message}</p>
          {state.retryable ? (
            <button className="uph-command" type="button" onClick={onRetry}>
              重新加载
            </button>
          ) : null}
        </section>
      </main>
    );
  }
  if (state.kind === "empty") {
    return (
      <main className="uph-page uph-state-page uph-viewport-safe">
        <section className="uph-state-panel">
          <p className="uph-kicker">PROJECT UPH</p>
          <h1>暂无测试批次</h1>
          <p>项目尚未形成可读取的UPH测试批次。</p>
        </section>
      </main>
    );
  }

  const batches = state.batches;
  const selectedBatch = batches.find((batch) => batch.id === state.selectedBatchId);
  const revision = state.kind === "no-locked" ? null : state.revision;
  const analyses = "analyses" in state ? state.analyses : [];
  return (
    <main className="uph-page uph-viewport-safe" aria-label="项目UPH分析">
      <header className="uph-header">
        <div>
          <p className="uph-kicker">PROJECT UPH / READ ONLY</p>
          <h1>UPH 分析</h1>
          <p className="uph-subtitle">仅展示当前 LOCKED 修订的确定性分析快照。</p>
        </div>
        <span className="uph-readonly-badge">只读</span>
      </header>

      <section className="uph-card uph-selector-card" aria-labelledby="uph-batch-title">
        <div className="uph-section-heading">
          <div>
            <p className="uph-kicker">SOURCE BATCH</p>
            <h2 id="uph-batch-title">测试批次</h2>
          </div>
          <span>{batches.length}个</span>
        </div>
        <div className="uph-batch-list">
          {batches.map((batch) => (
            <button
              className={`uph-batch-option${batch.id === state.selectedBatchId ? " is-selected" : ""}`}
              type="button"
              key={batch.id}
              onClick={() => onSelectBatch?.(batch.id)}
            >
              <strong className="uph-breakable">{displayValue(batch.batchNumber)}</strong>
              <span className="uph-breakable">
                {batch.currentLockedRevisionId ? "当前有 LOCKED" : "无 LOCKED 修订"}
              </span>
            </button>
          ))}
        </div>
        {selectedBatch ? (
          <p className="uph-meta uph-breakable">批次ID：{selectedBatch.id}</p>
        ) : null}
      </section>

      {state.kind === "no-locked" ? (
        <section className="uph-state-panel uph-inline-state">
          <h2>暂无当前 LOCKED 修订</h2>
          <p>该批次尚无可读取的冻结修订，页面不会发起分析生成请求。</p>
        </section>
      ) : null}

      {revision ? (
        <>
          <section className="uph-card uph-revision-card" aria-label="当前修订">
            <div>
              <p className="uph-kicker">CURRENT REVISION</p>
              <h2>修订 #{displayValue(revision.revisionNumber)}</h2>
              <p className="uph-meta uph-breakable">
                {revision.id} · {statusLabel(revision.status)}
              </p>
            </div>
            <dl className="uph-inline-details">
              <div>
                <dt>拓扑根</dt>
                <dd className="uph-breakable">{revision.topologyRootNodeId}</dd>
              </div>
              <div>
                <dt>模块数</dt>
                <dd>
                  {Array.isArray(revision.moduleBindings) ? revision.moduleBindings.length : 0}
                </dd>
              </div>
              <div>
                <dt>公式版本</dt>
                <dd className="uph-breakable">{revision.formulaVersionId}</dd>
              </div>
            </dl>
          </section>
          {revision.status === "SUPERSEDED" ? (
            <p className="uph-readonly-notice">该修订已被后续版本替代，历史分析快照仍可读取。</p>
          ) : null}
        </>
      ) : null}

      {state.kind === "partial" ? (
        <section className="uph-card uph-inline-state" aria-busy="true">
          <h2>正在读取分析快照</h2>
          <p>已读取批次与修订，正在加载分析明细。</p>
        </section>
      ) : null}
      {state.kind === "no-analysis" ? (
        <section className="uph-state-panel uph-inline-state">
          <h2>尚未生成分析</h2>
          <p>当前 LOCKED 修订还没有分析快照。</p>
        </section>
      ) : null}
      {state.kind === "populated" ? (
        <>
          <section className="uph-card uph-analysis-selector" aria-labelledby="uph-analysis-title">
            <div className="uph-section-heading">
              <div>
                <p className="uph-kicker">ANALYSIS SNAPSHOTS</p>
                <h2 id="uph-analysis-title">分析快照</h2>
              </div>
              <span>{analyses.length}个</span>
            </div>
            <div className="uph-analysis-list">
              {analyses.map((snapshot) => (
                <button
                  type="button"
                  className={`uph-analysis-option${snapshot.analysisId === state.selectedAnalysisId ? " is-selected" : ""}`}
                  key={snapshot.analysisId}
                  onClick={() => onSelectAnalysis?.(snapshot.analysisId)}
                >
                  <strong className="uph-breakable">{snapshot.analysisId}</strong>
                  <span className="uph-breakable">
                    {statusLabel(snapshot.status)} · {formatAnalysisCreatedAt(snapshot.createdAt)}
                  </span>
                </button>
              ))}
            </div>
          </section>
          <AnalysisDetail analysis={state.analysis} />
        </>
      ) : null}
    </main>
  );
}

export function UphPageClient({ projectId }: UphPageClientProps) {
  const [state, setState] = useState<UphPageState>({ kind: "loading" });

  const loadBatch = useCallback(
    async (batchId: string, batches: UphBatchSummary[]) => {
      setState({
        kind: "partial",
        batches,
        selectedBatchId: batchId,
        revision: null,
        analyses: []
      });
      setState(await fetchUphBatchState(projectId, batchId, batches));
    },
    [projectId]
  );

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState(await fetchUphPageState(projectId));
    } catch (error) {
      setState(deniedOrError(error));
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selectBatch = (batchId: string) => {
    if (
      state.kind === "empty" ||
      state.kind === "loading" ||
      state.kind === "denied" ||
      state.kind === "error"
    )
      return;
    void loadBatch(batchId, state.batches);
  };

  const selectAnalysis = async (analysisId: string) => {
    if (state.kind !== "populated") return;
    try {
      const analysis = await fetchUphAnalysisDetail(
        projectId,
        state.selectedBatchId,
        state.revision.id,
        analysisId
      );
      setState({ ...state, selectedAnalysisId: analysisId, analysis });
    } catch (error) {
      setState(deniedOrError(error));
    }
  };

  return (
    <UphAnalysisDashboardContent
      projectId={projectId}
      state={state}
      onRetry={() => void load()}
      onSelectBatch={selectBatch}
      onSelectAnalysis={(analysisId) => void selectAnalysis(analysisId)}
    />
  );
}
