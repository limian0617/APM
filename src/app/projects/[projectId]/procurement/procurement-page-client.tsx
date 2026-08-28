"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

export type ChangeImpactResolutionInput = Readonly<{
  impactId: string;
  obligationId: string;
  version: number;
  disposition: string;
  evidenceReference: string;
  reason: string;
}>;

type ProcurementPageContentProps = {
  projectId: string;
  state: ProcurementPageState;
  view: ProcurementPageView;
  fixture?: string | null;
  onRetry: () => void;
  onResolveChangeImpact?: (input: ChangeImpactResolutionInput) => Promise<void>;
};

type ChangeImpactIdempotencyKeyStore = Map<string, string>;

export function createChangeImpactIdempotencyKeyStore(): ChangeImpactIdempotencyKeyStore {
  return new Map();
}

export function idempotencyKeyForChangeImpactResolution(
  keys: ChangeImpactIdempotencyKeyStore,
  input: ChangeImpactResolutionInput
): string {
  const fingerprint = JSON.stringify([
    input.impactId,
    input.obligationId,
    input.version,
    input.disposition,
    input.evidenceReference,
    input.reason
  ]);
  const existing = keys.get(fingerprint);
  if (existing) return existing;

  const key = `procurement-change-impact-${globalThis.crypto.randomUUID()}`;
  keys.set(fingerprint, key);
  return key;
}

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

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
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
  scopeId,
  fixture
}: {
  projectId: string;
  label: string;
  value: unknown;
  view: ProcurementPageView;
  scopeId?: string;
  fixture?: string | null;
}) {
  return (
    <a
      className="procurement-metric"
      href={safeProcurementDrilldown(projectId, { view, scopeId, fixture }) ?? undefined}
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
  const sourceTimestamps =
    state.overview.sourceTimestamps && typeof state.overview.sourceTimestamps === "object"
      ? (state.overview.sourceTimestamps as Record<string, unknown>)
      : {};
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
      <div>
        <dt>需求来源</dt>
        <dd>{dateTime(sourceTimestamps.requirements)}</dd>
      </div>
      <div>
        <dt>跟踪来源</dt>
        <dd>{dateTime(sourceTimestamps.tracking)}</dd>
      </div>
      <div>
        <dt>履约来源</dt>
        <dd>{dateTime(sourceTimestamps.fulfillment)}</dd>
      </div>
      <div>
        <dt>变更影响来源</dt>
        <dd>{dateTime(sourceTimestamps.changeImpacts)}</dd>
      </div>
    </dl>
  );
}

function OverviewView({
  projectId,
  state,
  fixture
}: {
  projectId: string;
  state: Extract<ProcurementPageState, { status: "ready" | "stale" | "partial-denied" }>;
  fixture?: string | null;
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
          fixture={fixture}
        />
        <MetricLink
          projectId={projectId}
          label="逾期未到"
          value={overview.overdueCount}
          view="tracking"
          fixture={fixture}
        />
        <MetricLink
          projectId={projectId}
          label="待验收"
          value={overview.pendingAcceptanceCount}
          view="arrivals"
          fixture={fixture}
        />
        <MetricLink
          projectId={projectId}
          label="未下单"
          value={overview.notOrderedCount}
          view="tracking"
          fixture={fixture}
        />
        <MetricLink
          projectId={projectId}
          label="变更待处理"
          value={overview.changePendingCount}
          view="readiness"
          fixture={fixture}
        />
        <MetricLink
          projectId={projectId}
          label="阻塞装配"
          value={overview.blockingCount}
          view="readiness"
          fixture={fixture}
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
  state,
  onResolveChangeImpact
}: {
  projectId: string;
  state: Extract<ProcurementPageState, { status: "ready" | "stale" | "partial-denied" }>;
  onResolveChangeImpact?: ProcurementPageContentProps["onResolveChangeImpact"];
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
                  {number(scope.readyLines)}/{number(scope.totalLines)} 行
                </strong>
              </a>
            </li>
          );
        })}
      </ul>
      <ChangeImpactArea state={state} onResolveChangeImpact={onResolveChangeImpact} />
    </section>
  );
}

function ChangeImpactArea({
  state,
  onResolveChangeImpact
}: {
  state: Extract<ProcurementPageState, { status: "ready" | "stale" | "partial-denied" }>;
  onResolveChangeImpact?: ProcurementPageContentProps["onResolveChangeImpact"];
}) {
  const area = state.changeImpacts;
  if (area?.status === "loading") {
    return (
      <p className="procurement-empty-inline" role="status" aria-live="polite">
        重大采购变更加载中。
      </p>
    );
  }
  if (area?.status === "error") {
    return (
      <p className="procurement-restricted-notice" role="alert" aria-live="assertive">
        重大采购变更暂时不可用，请刷新后重试。
      </p>
    );
  }
  if (area?.status === "restricted") {
    return (
      <p className="procurement-restricted-notice" role="status" aria-live="polite">
        重大采购变更区域受限，无法显示数量、影响对象或处置证据。
      </p>
    );
  }
  if (!area) {
    return (
      <p className="procurement-empty-inline" role="status" aria-live="polite">
        重大采购变更状态尚未确认。
      </p>
    );
  }
  return (
    <ChangeImpactPanel
      impacts={list(area.data.impacts)}
      onResolveChangeImpact={onResolveChangeImpact}
    />
  );
}

const CHANGE_FIELD_LABELS: Record<string, string> = {
  materialReferenceId: "物料",
  quantity: "数量",
  trackingUnit: "单位",
  businessType: "业务类型",
  deliveryUnitId: "交付单元",
  moduleId: "模块",
  responsibilityPackageId: "责任包",
  taskId: "任务",
  requiredOn: "需求日期",
  predictedAssemblyStartOn: "预计装配开始",
  drawingId: "图纸",
  drawingVersionId: "图纸版本",
  outsourcedProcess: "委外工序",
  canceled: "取消"
};

function dispositionsForObligation(type: string): readonly string[] {
  switch (type) {
    case "PROCUREMENT_OWNER":
      return ["OWNER_PLAN_CONFIRMED"];
    case "SUPPLIER":
      return ["SUPPLIER_ACCEPTED"];
    case "ERP_PROJECTION":
      return ["ERP_PROJECTED"];
    default:
      return ["CANCELED", "REWORK", "RETURNED", "CONTINUE_USE"];
  }
}

function dispositionLabel(value: string): string {
  const labels: Record<string, string> = {
    OWNER_PLAN_CONFIRMED: "采购负责人已确认",
    SUPPLIER_ACCEPTED: "供应商已接受",
    ERP_PROJECTED: "ERP 投影已确认",
    CANCELED: "取消",
    REWORK: "返工",
    RETURNED: "退回",
    CONTINUE_USE: "继续使用"
  };
  return labels[value] ?? value;
}

function ChangeImpactObligationForm({
  impactId,
  obligation,
  version,
  onResolveChangeImpact
}: {
  impactId: string;
  obligation: Record<string, unknown>;
  version: number;
  onResolveChangeImpact?: ProcurementPageContentProps["onResolveChangeImpact"];
}) {
  const options = dispositionsForObligation(text(obligation.type));
  const [disposition, setDisposition] = useState(options[0] ?? "");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const obligationId = text(obligation.id);
  return (
    <form
      className="procurement-change-resolution-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!onResolveChangeImpact || !obligationId) return;
        setSubmitting(true);
        setError(null);
        void onResolveChangeImpact({
          impactId,
          obligationId,
          version,
          disposition,
          evidenceReference,
          reason
        })
          .catch(() => setError("处置证据提交失败，请刷新后重试。"))
          .finally(() => setSubmitting(false));
      }}
    >
      <label>
        处置方式
        <select value={disposition} onChange={(event) => setDisposition(event.target.value)}>
          {options.map((option) => (
            <option key={option} value={option}>
              {dispositionLabel(option)}
            </option>
          ))}
        </select>
      </label>
      <label>
        处置证据
        <input
          required
          value={evidenceReference}
          onChange={(event) => setEvidenceReference(event.target.value)}
        />
      </label>
      <label>
        处置说明
        <input required value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <button
        type="submit"
        className="procurement-command"
        disabled={!onResolveChangeImpact || submitting}
      >
        {submitting ? "提交中" : "提交处置"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}

function ChangeImpactPanel({
  impacts,
  onResolveChangeImpact
}: {
  impacts: readonly Record<string, unknown>[];
  onResolveChangeImpact?: ProcurementPageContentProps["onResolveChangeImpact"];
}) {
  const openImpacts = impacts.filter((impact) => text(impact.status) === "OPEN");
  return (
    <section className="procurement-change-impact-list" aria-label="重大采购变更影响">
      <div className="procurement-section-heading">
        <h2>未处置重大采购变更</h2>
        <span>{openImpacts.length} 项</span>
      </div>
      {openImpacts.length === 0 ? (
        <p className="procurement-empty-inline">暂无未处置重大采购变更。</p>
      ) : (
        <ul>
          {openImpacts.map((impact, index) => {
            const impactId = text(impact.id, `impact-${index}`);
            const version = number(impact.version, 0);
            const obligations = list(impact.obligations);
            return (
              <li key={impactId}>
                <div>
                  <strong>{text(impact.requirementId, impactId)}</strong>
                  <span>
                    影响字段：
                    {stringList(impact.changedFieldsJson)
                      .map((field) => CHANGE_FIELD_LABELS[field] ?? field)
                      .join("、") || "未提供"}
                  </span>
                </div>
                <ul>
                  {obligations.map((obligation, obligationIndex) => {
                    const resolution = obligation.resolution;
                    return (
                      <li key={text(obligation.id, `${impactId}-${obligationIndex}`)}>
                        <p>
                          {text(obligation.type)}：{text(obligation.subjectId)}
                        </p>
                        {resolution && typeof resolution === "object" ? (
                          <p>
                            已处置：
                            {dispositionLabel(
                              text((resolution as Record<string, unknown>).disposition)
                            )}
                          </p>
                        ) : (
                          <ChangeImpactObligationForm
                            impactId={impactId}
                            obligation={obligation}
                            version={version}
                            onResolveChangeImpact={onResolveChangeImpact}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function ProcurementPageContent({
  projectId,
  state,
  view,
  fixture,
  onRetry,
  onResolveChangeImpact
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
      {view === "overview" ? (
        <OverviewView projectId={projectId} state={state} fixture={fixture} />
      ) : null}
      {view === "requirements" ? <RequirementsView projectId={projectId} state={state} /> : null}
      {view === "tracking" ? <TrackingView projectId={projectId} state={state} /> : null}
      {view === "arrivals" ? <ArrivalsView state={state} /> : null}
      {view === "readiness" ? (
        <ReadinessView
          projectId={projectId}
          state={state}
          onResolveChangeImpact={onResolveChangeImpact}
        />
      ) : null}
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

export async function loadProcurementState(projectId: string): Promise<ProcurementPageState> {
  const root = `/api/projects/${encodeURIComponent(projectId)}`;
  const [overview, readiness, requirements, tracking, arrivals, suppliers, changeImpacts] =
    await Promise.all([
      fetchProcurementSource(`${root}/procurement/overview?view=overview`),
      fetchProcurementSource(`${root}/procurement/readiness?view=readiness`),
      fetchProcurementSource(`${root}/material-requirements?limit=100`),
      fetchProcurementSource(`${root}/procurement-tracking-lines?limit=100`),
      fetchProcurementSource(`${root}/procurement/fulfillment-events?limit=100`),
      fetchProcurementSource(`${root}/procurement/suppliers?limit=100`),
      fetchProcurementSource(`${root}/procurement/change-impacts?status=OPEN&limit=100`)
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
    suppliers,
    changeImpacts
  });
}

export function ProcurementPageClient({ projectId, initialState }: ProcurementPageClientProps) {
  const searchParams = useSearchParams();
  const view = selectedProcurementView(searchParams.get("view"));
  const fixture = searchParams.get("fixture");
  const [state, setState] = useState<ProcurementPageState>(
    initialState ?? { projectId, status: "loading" }
  );
  const changeImpactIdempotencyKeys = useRef(createChangeImpactIdempotencyKeyStore());
  const reload = useCallback(
    async () => setState(await loadProcurementState(projectId)),
    [projectId]
  );
  const resolveChangeImpact = useCallback(
    async (input: ChangeImpactResolutionInput) => {
      const idempotencyKey = idempotencyKeyForChangeImpactResolution(
        changeImpactIdempotencyKeys.current,
        input
      );
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/procurement/change-impacts/${encodeURIComponent(input.impactId)}/obligations/${encodeURIComponent(input.obligationId)}/resolve`,
        {
          method: "POST",
          cache: "no-store",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey
          },
          body: JSON.stringify({
            version: input.version,
            disposition: input.disposition,
            evidenceReference: input.evidenceReference,
            reason: input.reason
          })
        }
      );
      if (!response.ok) throw new Error("procurement change impact resolution failed");
      await reload();
    },
    [projectId, reload]
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
      onResolveChangeImpact={resolveChangeImpact}
    />
  );
}
