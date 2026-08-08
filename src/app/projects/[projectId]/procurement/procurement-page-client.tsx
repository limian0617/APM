"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  buildProcurementPageState,
  procurementPageHref,
  safeProcurementDrilldown,
  selectedProcurementView,
  toProcurementFetchResult,
  type ProcurementFetchResult,
  type ProcurementDataState,
  type ProcurementPageState,
  type ProcurementPageView
} from "@/modules/procurement/contracts/procurement-page-state";

type ProcurementPageClientProps = {
  projectId: string;
  initialState: ProcurementPageState | null;
};

type ProcurementPageContentProps = {
  projectId: string;
  state: ProcurementPageState;
  view: ProcurementPageView;
  fixture?: string | null;
  onRetry: () => void;
};

function isProcurementDataState(state: ProcurementPageState): state is ProcurementDataState {
  return state.status === "ready" || state.status === "stale" || state.status === "partial-denied";
}

const VIEW_LABELS: Record<ProcurementPageView, string> = {
  overview: "采购总览",
  requirements: "采购需求",
  tracking: "采购跟踪",
  arrivals: "到货与验收",
  readiness: "齐套与影响"
};

const STATUS_LABELS: Record<string, string> = {
  READY: "可用",
  STALE: "已过期",
  PENDING: "计算中",
  FAILED: "计算失败",
  EMPTY: "暂无数据",
  ORDERED: "已下单",
  PARTIALLY_ARRIVED: "部分到货",
  PENDING_ACCEPTANCE: "待验收",
  PURCHASE_ARRIVED: "采购到货",
  ACCEPTED: "验收合格",
  REJECTED: "已拒收",
  RETURNED: "已退回"
};

function text(value: unknown, fallback = "未提供") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function number(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function list(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item)
      )
    : [];
}

function percent(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}%` : "暂无";
}

function dateTime(value: unknown) {
  if (typeof value !== "string") return "尚无时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚无时间";
  return value.slice(0, 16).replace("T", " ");
}

function statusLabel(value: unknown) {
  return STATUS_LABELS[text(value)] ?? text(value);
}

function errorStateMessage(state: ProcurementPageState) {
  if (state.status === "error") return state.retryable ? "采购读取暂时不可用。" : "采购读取失败。";
  if (state.status === "failed") return "齐套计算失败，当前结果不可作为正常数据使用。";
  return "当前项目采购数据状态需要关注。";
}

function ProcurementStatePanel({
  state,
  onRetry
}: {
  state: Extract<
    ProcurementPageState,
    { status: "loading" | "pending" | "failed" | "error" | "denied" | "not-available" | "empty" }
  >;
  onRetry: () => void;
}) {
  const labels: Record<typeof state.status, string> = {
    loading: "采购数据加载中",
    pending: "齐套计算中",
    failed: "采购数据计算失败",
    error: "采购信息暂不可用",
    denied: "无权查看项目采购信息",
    "not-available": "尚未生成采购齐套结果",
    empty: "暂无采购数据"
  };
  return (
    <main
      className="procurement-page procurement-state-page"
      aria-busy={state.status === "loading"}
    >
      <section className="procurement-state-panel" aria-labelledby="procurement-state-title">
        <p className="procurement-eyebrow">PROJECT PROCUREMENT</p>
        <h1 id="procurement-state-title">{labels[state.status]}</h1>
        <p>
          {state.status === "denied"
            ? "当前身份没有此项目采购读取权限。"
            : errorStateMessage(state)}
        </p>
        {state.status === "error" && state.retryable ? (
          <button type="button" className="procurement-command" onClick={onRetry}>
            重新加载
          </button>
        ) : null}
      </section>
    </main>
  );
}

function ViewNavigation({
  projectId,
  view,
  fixture
}: {
  projectId: string;
  view: ProcurementPageView;
  fixture?: string | null;
}) {
  return (
    <nav className="procurement-view-navigation" aria-label="采购视图导航">
      <div className="procurement-view-navigation-list">
        {(Object.keys(VIEW_LABELS) as ProcurementPageView[]).map((candidate) => (
          <a
            key={candidate}
            className={candidate === view ? "is-active" : undefined}
            href={procurementPageHref(projectId, candidate, fixture)}
            aria-current={candidate === view ? "page" : undefined}
          >
            {VIEW_LABELS[candidate]}
          </a>
        ))}
      </div>
    </nav>
  );
}

function SourceBand({
  state
}: {
  state: Extract<ProcurementPageState, { status: "ready" | "stale" | "partial-denied" }>;
}) {
  const overview = state.overview;
  const readiness = state.readiness;
  const mode = text(overview.mode, "未知模式");
  return (
    <section className="procurement-context-band" aria-label="采购项目上下文">
      <div>
        <span>运行模式</span>
        <strong>{mode === "ERP" ? "ERP 只读投影" : "LOCAL 本地台账"}</strong>
      </div>
      <div>
        <span>整体齐套</span>
        <strong>{percent(overview.overallReadinessRate)}</strong>
      </div>
      <div>
        <span>关键物料齐套</span>
        <strong>{percent(overview.criticalReadinessRate)}</strong>
      </div>
      <div>
        <span>数据状态</span>
        <strong>{state.status === "stale" ? "已过期" : statusLabel(readiness.status)}</strong>
      </div>
      {mode === "LOCAL" ? <small>项目本地台账，不代表企业库存或财务订单。</small> : null}
    </section>
  );
}

function MetricLink({
  projectId,
  label,
  value,
  view,
  scopeId
}: {
  projectId: string;
  label: string;
  value: unknown;
  view: ProcurementPageView;
  scopeId?: string;
}) {
  return (
    <a
      className="procurement-metric"
      href={safeProcurementDrilldown(projectId, { view, scopeId }) ?? undefined}
    >
      <span>{label}</span>
      <strong>{number(value)}</strong>
    </a>
  );
}

function TimestampList({
  state
}: {
  state: Extract<ProcurementPageState, { status: "ready" | "stale" | "partial-denied" }>;
}) {
  return (
    <dl className="procurement-source-timestamps" aria-label="采购来源时间">
      <div>
        <dt>总览来源</dt>
        <dd>{dateTime(state.timestamps.overview)}</dd>
      </div>
      <div>
        <dt>齐套计算</dt>
        <dd>{dateTime(state.timestamps.readiness)}</dd>
      </div>
      <div>
        <dt>公式版本</dt>
        <dd>{text(state.readiness.formulaVersion)}</dd>
      </div>
      <div>
        <dt>输入水位</dt>
        <dd>{text(state.readiness.inputWatermark)}</dd>
      </div>
    </dl>
  );
}

function OverviewView({
  projectId,
  state
}: {
  projectId: string;
  state: Extract<ProcurementPageState, { status: "ready" | "stale" | "partial-denied" }>;
}) {
  const overview = state.overview;
  return (
    <>
      <section className="procurement-metric-strip" aria-label="采购关键指标">
        <MetricLink
          projectId={projectId}
          label="关键缺料"
          value={overview.criticalGapLines ?? overview.blockingCount}
          view="readiness"
        />
        <MetricLink
          projectId={projectId}
          label="逾期未到"
          value={overview.overdueCount}
          view="tracking"
        />
        <MetricLink
          projectId={projectId}
          label="待验收"
          value={overview.pendingAcceptanceCount}
          view="arrivals"
        />
        <MetricLink
          projectId={projectId}
          label="未下单"
          value={overview.notOrderedCount}
          view="tracking"
        />
        <MetricLink
          projectId={projectId}
          label="变更待处理"
          value={overview.changePendingCount}
          view="readiness"
        />
        <MetricLink
          projectId={projectId}
          label="阻塞装配"
          value={overview.blockingCount}
          view="readiness"
        />
      </section>
      <section className="procurement-exception-list" aria-label="采购异常与待处理">
        <div className="procurement-section-heading">
          <div>
            <p className="procurement-section-kicker">优先处理</p>
            <h2>采购异常与待处理</h2>
          </div>
          <span>
            {number(overview.notOrderedCount) +
              number(overview.overdueCount) +
              number(overview.changePendingCount)}{" "}
            项
          </span>
        </div>
        <ul>
          <li>关键缺料：{number(overview.criticalGapLines ?? overview.blockingCount)} 条</li>
          <li>变更待处理：{number(overview.changePendingCount)} 条</li>
          <li>数据状态：{state.status === "stale" ? "过期，需重新计算" : "当前快照可用"}</li>
        </ul>
      </section>
      {state.suppliers?.status === "restricted" ? (
        <p className="procurement-restricted-notice">
          供应商区域受限，无法显示数量、负责人或详情。
        </p>
      ) : null}
      <TimestampList state={state} />
    </>
  );
}

function RequirementsView({
  projectId,
  state
}: {
  projectId: string;
  state: Extract<ProcurementPageState, { status: "ready" | "stale" | "partial-denied" }>;
}) {
  const requirements = list(state.overview.requirements);
  return (
    <section className="procurement-tree" aria-label="采购需求树">
      <div className="procurement-section-heading">
        <h2>采购需求树</h2>
        <span>{requirements.length} 行</span>
      </div>
      {requirements.length === 0 ? (
        <p className="procurement-empty-inline">暂无项目采购需求。</p>
      ) : (
        <ul>
          {requirements.map((item, index) => {
            const id = text(item.id, `requirement-${index}`);
            return (
              <li key={id}>
                <a
                  href={
                    safeProcurementDrilldown(projectId, { view: "requirements", scopeId: id }) ??
                    undefined
                  }
                >
                  <strong>{text(item.name, id)}</strong>
                  <span>{statusLabel(item.status)}</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function TrackingView({
  projectId,
  state
}: {
  projectId: string;
  state: Extract<ProcurementPageState, { status: "ready" | "stale" | "partial-denied" }>;
}) {
  const rows = list(state.overview.tracking);
  return (
    <section className="procurement-table-section" aria-label="采购跟踪表">
      <div className="procurement-section-heading">
        <h2>采购跟踪表</h2>
        <span>{rows.length} 行</span>
      </div>
      {rows.length === 0 ? (
        <p className="procurement-empty-inline">暂无采购或委外跟踪行。</p>
      ) : (
        <div className="procurement-table-wrap">
          <table>
            <thead>
              <tr>
                <th>需求</th>
                <th>状态</th>
                <th>承诺日期</th>
                <th>来源</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const id = text(row.id, `tracking-${index}`);
                const rawStatus = text(row.displayStatus ?? row.status, "UNKNOWN");
                return (
                  <tr key={id}>
                    <th scope="row">
                      <a
                        href={
                          safeProcurementDrilldown(projectId, { view: "tracking", scopeId: id }) ??
                          undefined
                        }
                      >
                        {text(row.requirementId, id)}
                      </a>
                    </th>
                    <td>
                      {statusLabel(rawStatus)} ({rawStatus})
                    </td>
                    <td>{text(row.promisedOn, "未承诺")}</td>
                    <td>{text(row.source, "LOCAL")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ArrivalsView({
  state
}: {
  state: Extract<ProcurementPageState, { status: "ready" | "stale" | "partial-denied" }>;
}) {
  const events = list(state.overview.arrivals);
  return (
    <section className="procurement-timeline" aria-label="履约时间线">
      <div className="procurement-section-heading">
        <h2>履约时间线</h2>
        <span>{events.length} 事件</span>
      </div>
      {events.length === 0 ? (
        <p className="procurement-empty-inline">暂无到货或验收事件。</p>
      ) : (
        <ol>
          {events.map((event, index) => {
            const rawType = text(event.eventType, "UNKNOWN");
            return (
              <li key={text(event.id, `event-${index}`)}>
                <strong>
                  {statusLabel(rawType)} ({rawType})
                </strong>
                <span>{text(event.businessOccurredAt, "时间未提供")}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function ReadinessView({
  projectId,
  state
}: {
  projectId: string;
  state: Extract<ProcurementPageState, { status: "ready" | "stale" | "partial-denied" }>;
}) {
  const scopes = list(state.readiness.scopes);
  return (
    <section className="procurement-readiness-tree" aria-label="树状齐套">
      <div className="procurement-section-heading">
        <h2>树状齐套</h2>
        <span>{scopes.length} 个范围</span>
      </div>
      <ul>
        {scopes.map((scope, index) => {
          const id = text(scope.scopeId, `scope-${index}`);
          return (
            <li key={`${text(scope.scopeType)}:${id}`}>
              <a
                href={
                  safeProcurementDrilldown(projectId, { view: "readiness", scopeId: id }) ??
                  undefined
                }
              >
                <span>{text(scope.scopeType)}</span>
                <strong>
                  {number(scope.readyLineCount)}/{number(scope.lineCount)} 行
                </strong>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ProcurementPageContent({
  projectId,
  state,
  view,
  fixture,
  onRetry
}: ProcurementPageContentProps) {
  if (!isProcurementDataState(state)) {
    return <ProcurementStatePanel state={state} onRetry={onRetry} />;
  }
  return (
    <main className="procurement-page" aria-label="项目采购工作台">
      <header className="procurement-header">
        <div>
          <p className="procurement-eyebrow">PROJECT PROCUREMENT</p>
          <h1>{text(state.overview.projectName, "项目采购协同")}</h1>
          <p>{text(state.overview.projectCode, projectId)}</p>
        </div>
        <TimestampList state={state} />
      </header>
      <ViewNavigation projectId={projectId} view={view} fixture={fixture} />
      <SourceBand state={state} />
      {view === "overview" ? <OverviewView projectId={projectId} state={state} /> : null}
      {view === "requirements" ? <RequirementsView projectId={projectId} state={state} /> : null}
      {view === "tracking" ? <TrackingView projectId={projectId} state={state} /> : null}
      {view === "arrivals" ? <ArrivalsView state={state} /> : null}
      {view === "readiness" ? <ReadinessView projectId={projectId} state={state} /> : null}
    </main>
  );
}

async function fetchProcurementSource(path: string): Promise<ProcurementFetchResult> {
  try {
    const response = await fetch(path, { cache: "no-store" });
    const body = await response.json().catch(() => undefined);
    if (body === undefined && response.ok) return { kind: "error", status: 502, retryable: true };
    return toProcurementFetchResult({
      status: response.status,
      body,
      fetchedAt: new Date().toISOString()
    });
  } catch {
    return { kind: "error", status: 503, retryable: true };
  }
}

async function loadProcurementState(projectId: string): Promise<ProcurementPageState> {
  const root = `/api/projects/${encodeURIComponent(projectId)}`;
  const [overview, readiness, requirements, tracking, arrivals, suppliers] = await Promise.all([
    fetchProcurementSource(`${root}/procurement/overview?view=overview`),
    fetchProcurementSource(`${root}/procurement/readiness?view=readiness`),
    fetchProcurementSource(`${root}/material-requirements?limit=100`),
    fetchProcurementSource(`${root}/procurement-tracking-lines?limit=100`),
    fetchProcurementSource(`${root}/procurement/fulfillment-events?limit=100`),
    fetchProcurementSource(`${root}/procurement/suppliers?limit=100`)
  ]);
  const overviewBody = overview.kind === "ok" ? overview.body : {};
  const mergedOverview = {
    ...overviewBody,
    requirements: requirements.kind === "ok" ? requirements.body.requirements : [],
    tracking: tracking.kind === "ok" ? tracking.body.items : [],
    arrivals: arrivals.kind === "ok" ? arrivals.body.events : []
  };
  return buildProcurementPageState({
    projectId,
    overview: overview.kind === "ok" ? { ...overview, body: mergedOverview } : overview,
    readiness,
    suppliers
  });
}

export function ProcurementPageClient({ projectId, initialState }: ProcurementPageClientProps) {
  const searchParams = useSearchParams();
  const view = selectedProcurementView(searchParams.get("view"));
  const fixture = searchParams.get("fixture");
  const [state, setState] = useState<ProcurementPageState>(
    initialState ?? { projectId, status: "loading" }
  );
  const reload = useCallback(
    async () => setState(await loadProcurementState(projectId)),
    [projectId]
  );
  useEffect(() => {
    if (initialState) return;
    let cancelled = false;
    void loadProcurementState(projectId).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [initialState, projectId]);
  return (
    <ProcurementPageContent
      projectId={projectId}
      state={state}
      view={view}
      fixture={fixture}
      onRetry={() => void reload()}
    />
  );
}
