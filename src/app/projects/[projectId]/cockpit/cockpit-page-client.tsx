"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  buildCockpitDashboardPageState,
  cockpitDashboardHref,
  loadCockpitDashboardSources,
  safeProjectDrilldownPath,
  selectRiskCell,
  selectedCockpitView,
  type CockpitDashboardDataState,
  type CockpitDashboardPageState,
  type CockpitDashboardView,
  type RiskCell,
  type RiskCellKey
} from "@/modules/cockpit/contracts/cockpit-dashboard-page-state";

type CockpitPageClientProps = {
  projectId: string;
  initialState: CockpitDashboardPageState | null;
};

type CockpitDashboardContentProps = {
  projectId: string;
  state: CockpitDashboardPageState;
  view: CockpitDashboardView;
  risk: RiskCellKey | null;
  fixture?: string;
  onRetry: () => void;
};

const HEALTH_LABELS: Record<CockpitDashboardDataState["cockpit"]["health"], string> = {
  UNKNOWN: "未知",
  HEALTHY: "正常",
  ATTENTION: "需关注",
  CRITICAL: "严重"
};

const STATUS_LABELS: Record<string, string> = {
  IN_PROGRESS: "执行中",
  PENDING: "待确认",
  ACHIEVED: "已达成",
  OVERDUE: "已逾期",
  VOID: "已作废",
  ACCEPTED: "已验收",
  CLOSED: "已关闭",
  TRIGGERED: "已触发",
  ACKNOWLEDGED: "已确认",
  FAILED: "计算失败",
  RUNNING: "计算中",
  SUCCEEDED: "计算完成"
};

function statusLabel(value: string) {
  return STATUS_LABELS[value] ?? value;
}

function formatDate(value: string | null) {
  if (!value) return "未设定";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未设定";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function formatTimestamp(value: string | null) {
  if (!value) return "尚无时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚无时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function localPath(projectId: string, path: string) {
  return safeProjectDrilldownPath(projectId, path);
}

function stageName(stage: { name?: string; code?: string; projectStageId: string }) {
  return stage.name ?? stage.code ?? stage.projectStageId;
}

function mainControlStage(state: CockpitDashboardDataState) {
  return (
    state.stages.projectStages.find((stage) => stage.status === "IN_PROGRESS") ??
    [...state.stages.projectStages].sort(
      (left, right) => (left.sequence ?? 0) - (right.sequence ?? 0)
    )[0] ??
    null
  );
}

function progressPercent(state: CockpitDashboardDataState) {
  return state.execution.progress.status === "READY" ? state.execution.progress.percent : null;
}

function sourceTimestampList(state: CockpitDashboardDataState) {
  return [
    ["驾驶舱", state.sourceTimestamps.cockpit],
    ["进度", state.sourceTimestamps.execution.progressCalculatedAt],
    ["预测请求", state.sourceTimestamps.execution.scheduleRequestedAt],
    ["预测结果", state.sourceTimestamps.execution.scheduleCalculatedAt]
  ] as const;
}

function StatePanel({
  title,
  message,
  retryable,
  onRetry
}: {
  title: string;
  message: string;
  retryable?: boolean;
  onRetry: () => void;
}) {
  return (
    <main className="cockpit-page cockpit-state-page">
      <section className="cockpit-state-panel" aria-labelledby="cockpit-state-title">
        <p className="cockpit-eyebrow">PROJECT COCKPIT</p>
        <h1 id="cockpit-state-title">{title}</h1>
        <p>{message}</p>
        {retryable ? (
          <button className="cockpit-command" type="button" onClick={onRetry}>
            重新加载
          </button>
        ) : null}
      </section>
    </main>
  );
}

function ContextBand({ state }: { state: CockpitDashboardDataState }) {
  const stage = mainControlStage(state);
  const percent = progressPercent(state);
  return (
    <section className="cockpit-context-band" aria-label="驾驶舱项目上下文">
      <div>
        <span>派生健康度</span>
        <strong>{HEALTH_LABELS[state.cockpit.health]}</strong>
      </div>
      <div>
        <span>主控阶段</span>
        <strong>{stage ? stageName(stage) : "尚未确定"}</strong>
      </div>
      <div>
        <span>项目进度</span>
        <strong>{percent === null ? "暂无有效计划" : `${percent.toFixed(1)}%`}</strong>
      </div>
      <div>
        <span>驾驶舱计算时间</span>
        <strong>{formatTimestamp(state.sourceTimestamps.cockpit)}</strong>
      </div>
    </section>
  );
}

function FreshnessNotices({ state }: { state: CockpitDashboardDataState }) {
  const notices: string[] = [];
  if (state.kind === "stale" || state.execution.schedule.stale) {
    notices.push(
      `预测数据已过期，最近计算：${formatTimestamp(state.execution.schedule.calculatedAt)}`
    );
  }
  if (state.kind === "pending" || state.execution.schedule.status === "PENDING") {
    notices.push("计划预测正在计算，当前显示最近可用数据。");
  }
  if (state.kind === "failed") notices.push(`计划预测计算失败：${state.message}`);
  if (state.alerts.kind === "ready" && state.alerts.data.freshness.status !== "SUCCEEDED") {
    notices.push(`预警数据状态：${statusLabel(state.alerts.data.freshness.status)}`);
  }
  if (notices.length === 0) return null;
  return (
    <section className="cockpit-notice-list" aria-label="驾驶舱数据状态">
      {notices.map((notice) => (
        <p key={notice}>{notice}</p>
      ))}
    </section>
  );
}

type ExceptionRow = { key: string; title: string; detail: string; href: string | null };

function exceptionRows(
  projectId: string,
  state: CockpitDashboardDataState,
  fixture?: string
): ExceptionRow[] {
  const rows: ExceptionRow[] = state.cockpit.exceptions.map((exception) => ({
    key: `cockpit:${exception.exceptionId}`,
    title: exception.summary,
    detail: `${exception.kind} · ${exception.severity}`,
    href: exception.drilldownPath
  }));
  rows.push(
    ...state.execution.criticalExceptions.map((exception) => ({
      key: `critical:${exception.taskId}`,
      title: `关键路径延期：${exception.name}`,
      detail: `计划 ${formatDate(exception.plannedFinishAt)} · 预测 ${formatDate(exception.predictedFinishAt)}`,
      href: localPath(
        projectId,
        `/projects/${encodeURIComponent(projectId)}/execution?task=${encodeURIComponent(exception.taskId)}`
      )
    }))
  );
  rows.push(
    ...state.execution.milestones
      .filter((milestone) => milestone.status === "OVERDUE")
      .map((milestone) => ({
        key: `milestone:${milestone.milestoneId}`,
        title: `里程碑逾期：${milestone.name}`,
        detail: `目标 ${formatDate(milestone.targetAt)}`,
        href: localPath(
          projectId,
          `/projects/${encodeURIComponent(projectId)}/execution?milestone=${encodeURIComponent(milestone.milestoneId)}`
        )
      }))
  );
  const highRiskCount =
    state.risk?.cells
      .filter((cell) => cell.probability === "HIGH")
      .reduce((total, cell) => total + cell.count, 0) ?? 0;
  if (highRiskCount > 0) {
    rows.push({
      key: "risk:high",
      title: `高风险预警：${highRiskCount} 条`,
      detail: "请进入风险与问题视图核查风险单元格。",
      href: cockpitDashboardHref(projectId, "risks", null, fixture)
    });
  }
  if (state.issueSummary?.severe.length) {
    rows.push({
      key: "issues:severe",
      title: `严重问题：${state.issueSummary.severe.length} 条`,
      detail: "请进入问题列表处理严重问题。",
      href: localPath(projectId, `/projects/${encodeURIComponent(projectId)}/issues`)
    });
  }
  if (state.kind === "stale") {
    rows.push({
      key: "freshness:stale",
      title: "数据过期",
      detail: "当前展示最近一次可用计算结果。",
      href: null
    });
  }
  return rows;
}

function ExceptionList({
  projectId,
  state,
  fixture
}: {
  projectId: string;
  state: CockpitDashboardDataState;
  fixture?: string;
}) {
  const rows = exceptionRows(projectId, state, fixture);
  return (
    <section className="cockpit-exception-list" aria-labelledby="cockpit-exception-title">
      <div className="cockpit-section-heading">
        <div>
          <p className="cockpit-section-kicker">优先处理</p>
          <h2 id="cockpit-exception-title">异常与待决策事项</h2>
        </div>
        <span>{rows.length} 项</span>
      </div>
      {rows.length === 0 ? (
        <p className="cockpit-empty-inline">当前没有需要优先处理的异常。</p>
      ) : (
        <div className="cockpit-list">
          {rows.map((row) => (
            <div className="cockpit-list-row" key={row.key}>
              <span>
                <strong>{row.title}</strong>
                <small>{row.detail}</small>
              </span>
              {row.href ? <a href={row.href}>查看</a> : <span>需关注</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function StageDistribution({ state }: { state: CockpitDashboardDataState }) {
  const groups = [
    ["项目主控阶段", state.stages.projectStages],
    ["交付单元阶段", state.stages.deliveryUnitStages]
  ] as const;
  return (
    <section className="cockpit-stage-distribution" aria-label="阶段分布">
      {groups.map(([label, stages]) => (
        <div key={label}>
          <h3>{label}</h3>
          {stages.length === 0 ? (
            <p>暂无阶段数据</p>
          ) : (
            <ul>
              {stages.map((stage) => (
                <li key={`${stage.projectStageId}:${stage.deliveryUnitStageId ?? "project"}`}>
                  <span>{stageName(stage)}</span>
                  <strong>{statusLabel(stage.status)}</strong>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

function SourceTimestamps({ state }: { state: CockpitDashboardDataState }) {
  return (
    <dl className="cockpit-source-timestamps" aria-label="来源时间">
      {sourceTimestampList(state).map(([label, timestamp]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{formatTimestamp(timestamp)}</dd>
        </div>
      ))}
    </dl>
  );
}

function OverviewView({
  projectId,
  state,
  fixture
}: {
  projectId: string;
  state: CockpitDashboardDataState;
  fixture?: string;
}) {
  return (
    <>
      <ExceptionList projectId={projectId} state={state} fixture={fixture} />
      <section className="cockpit-overview-detail" aria-label="项目关键事实">
        <div>
          <h2>项目关键事实</h2>
          <p>项目状态：{statusLabel(state.execution.project.status)}</p>
          <p>预测完成：{formatDate(state.execution.schedule.projectFinishAt)}</p>
        </div>
        <StageDistribution state={state} />
      </section>
    </>
  );
}

function ProgressView({
  projectId,
  state
}: {
  projectId: string;
  state: CockpitDashboardDataState;
}) {
  const progress = state.execution.progress;
  const nextMilestone =
    state.execution.milestones
      .filter((milestone) => milestone.status === "PENDING")
      .sort((left, right) =>
        (left.targetAt ?? "9999").localeCompare(right.targetAt ?? "9999")
      )[0] ?? null;
  return (
    <>
      <section className="cockpit-progress-facts" aria-label="计划事实对比">
        <div>
          <span>基线</span>
          <strong>发布输入版本 {state.execution.schedule.publishedInputVersion ?? "未发布"}</strong>
          <small>来源版本 {state.execution.schedule.inputVersion}</small>
        </div>
        <div>
          <span>当前预测</span>
          <strong>{formatDate(state.execution.schedule.projectFinishAt)}</strong>
          <small>{statusLabel(state.execution.schedule.status)}</small>
        </div>
        <div>
          <span>实际事实</span>
          <strong>
            {progress.status === "READY"
              ? `${progress.completedWorkdays} 天已完成`
              : "暂无有效计划"}
          </strong>
          <small>
            {progress.status === "READY"
              ? `共 ${progress.totalWorkdays} 天`
              : `计算时间 ${formatTimestamp(progress.calculatedAt)}`}
          </small>
        </div>
      </section>
      <section className="cockpit-milestone-section" aria-label="里程碑与关键路径">
        <div>
          <h2>下一个关键里程碑</h2>
          {nextMilestone ? (
            <a
              href={
                localPath(
                  projectId,
                  `/projects/${encodeURIComponent(projectId)}/execution?milestone=${encodeURIComponent(nextMilestone.milestoneId)}`
                ) ?? "#"
              }
            >
              {nextMilestone.name} · {formatDate(nextMilestone.targetAt)}
            </a>
          ) : (
            <p>没有待确认里程碑。</p>
          )}
        </div>
        <div>
          <h2>关键路径延期</h2>
          {state.execution.criticalExceptions.length === 0 ? (
            <p>当前没有关键路径延期。</p>
          ) : (
            <ul>
              {state.execution.criticalExceptions.map((exception) => (
                <li key={exception.taskId}>
                  {exception.name}：预测 {formatDate(exception.predictedFinishAt)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <StageDistribution state={state} />
    </>
  );
}

function RiskCellLink({
  projectId,
  cell,
  selected,
  fixture
}: {
  projectId: string;
  cell: RiskCell;
  selected: boolean;
  fixture?: string;
}) {
  return (
    <a
      className={selected ? "is-selected" : undefined}
      href={cockpitDashboardHref(projectId, "risks", cell.key, fixture)}
      aria-label={`${cell.probability} / ${cell.impact} 风险 ${cell.count} 条`}
      aria-current={selected ? "true" : undefined}
    >
      <span>
        {cell.probability} / {cell.impact}
      </span>
      <strong>{cell.count} 条</strong>
    </a>
  );
}

function RiskMatrix({
  projectId,
  state,
  selectedRisk,
  fixture
}: {
  projectId: string;
  state: CockpitDashboardDataState;
  selectedRisk: RiskCellKey | null;
  fixture?: string;
}) {
  if (!state.risk) return null;
  return (
    <section aria-label="风险矩阵">
      <div className="cockpit-risk-matrix" role="grid" aria-label="概率影响风险矩阵">
        {state.risk.cells.map((cell) => (
          <RiskCellLink
            key={cell.key}
            projectId={projectId}
            cell={cell}
            selected={cell.key === selectedRisk}
            fixture={fixture}
          />
        ))}
      </div>
      <div className="cockpit-risk-list" aria-label="风险矩阵列表">
        {state.risk.cells.map((cell) => (
          <RiskCellLink
            key={cell.key}
            projectId={projectId}
            cell={cell}
            selected={cell.key === selectedRisk}
            fixture={fixture}
          />
        ))}
      </div>
    </section>
  );
}

function OptionalNotice({ label, kind }: { label: string; kind: "restricted" | "error" }) {
  return (
    <p className="cockpit-restricted-notice">
      {kind === "restricted"
        ? `${label}区域受限，无法显示数量、负责人或详情。`
        : `${label}区域暂时无法读取。`}
    </p>
  );
}

function SelectedRiskAlerts({
  state,
  selectedRisk
}: {
  state: CockpitDashboardDataState;
  selectedRisk: RiskCellKey | null;
}) {
  if (state.alerts.kind === "restricted") return <OptionalNotice label="预警" kind="restricted" />;
  if (state.alerts.kind === "error") return <OptionalNotice label="预警" kind="error" />;
  if (!selectedRisk || !state.risk)
    return <p className="cockpit-empty-inline">选择风险单元格查看已授权预警。</p>;
  const selected = selectRiskCell(state, selectedRisk);
  if (!selected) return <p className="cockpit-empty-inline">未找到该风险单元格。</p>;
  return (
    <section className="cockpit-selected-risk" aria-label="选中风险预警">
      <h2>
        {selected.probability} / {selected.impact} 预警
      </h2>
      {selected.items.length === 0 ? (
        <p>该单元格暂无有效预警。</p>
      ) : (
        <ul>
          {selected.items.map((item) => (
            <li key={item.alertId}>
              <strong>{item.ruleCode}</strong>
              <span>
                {statusLabel(item.status)} · {item.sourceKey}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function IssueList({
  projectId,
  title,
  issues
}: {
  projectId: string;
  title: string;
  issues: NonNullable<CockpitDashboardDataState["issueSummary"]>["severe"];
}) {
  return (
    <section className="cockpit-issue-list" aria-label={title}>
      <h2>{title}</h2>
      {issues.length === 0 ? (
        <p>暂无{title}。</p>
      ) : (
        <ul>
          {issues.map((issue) => (
            <li key={issue.id}>
              <a
                href={
                  localPath(
                    projectId,
                    `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issue.id)}`
                  ) ?? "#"
                }
              >
                <strong>{issue.title}</strong>
                <span>
                  {statusLabel(issue.status)} · {issue.owner?.name ?? "未分配"}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RisksView({
  projectId,
  state,
  risk,
  fixture
}: {
  projectId: string;
  state: CockpitDashboardDataState;
  risk: RiskCellKey | null;
  fixture?: string;
}) {
  return (
    <>
      <section className="cockpit-risk-section" aria-label="风险与问题">
        <h2>风险矩阵</h2>
        <RiskMatrix projectId={projectId} state={state} selectedRisk={risk} fixture={fixture} />
        <SelectedRiskAlerts state={state} selectedRisk={risk} />
      </section>
      {state.issues.kind === "restricted" ? (
        <OptionalNotice label="问题" kind="restricted" />
      ) : state.issues.kind === "error" ? (
        <OptionalNotice label="问题" kind="error" />
      ) : state.issueSummary ? (
        <section className="cockpit-issues-summary" aria-label="问题摘要">
          <IssueList projectId={projectId} title="严重问题" issues={state.issueSummary.severe} />
          <IssueList projectId={projectId} title="逾期问题" issues={state.issueSummary.overdue} />
        </section>
      ) : null}
    </>
  );
}

function DataView({
  projectId,
  state,
  view,
  risk,
  fixture
}: {
  projectId: string;
  state: CockpitDashboardDataState;
  view: CockpitDashboardView;
  risk: RiskCellKey | null;
  fixture?: string;
}) {
  return (
    <main className="cockpit-page" aria-label="项目驾驶舱">
      <header className="cockpit-header">
        <div>
          <p className="cockpit-eyebrow">PROJECT COCKPIT</p>
          <h1>{state.execution.project.name}</h1>
          <p>{state.execution.project.code}</p>
        </div>
        <SourceTimestamps state={state} />
      </header>
      <ContextBand state={state} />
      <FreshnessNotices state={state} />
      {state.kind === "empty" ? (
        <section className="cockpit-state-panel" aria-label="驾驶舱暂无有效计划">
          <h2>暂无有效计划</h2>
          <p>当前项目没有参与驾驶舱进度计算的有效计划任务。</p>
        </section>
      ) : null}
      {state.kind !== "empty" && view === "overview" ? (
        <OverviewView projectId={projectId} state={state} fixture={fixture} />
      ) : null}
      {state.kind !== "empty" && view === "progress" ? (
        <ProgressView projectId={projectId} state={state} />
      ) : null}
      {state.kind !== "empty" && view === "risks" ? (
        <RisksView projectId={projectId} state={state} risk={risk} fixture={fixture} />
      ) : null}
    </main>
  );
}

export function CockpitDashboardContent({
  projectId,
  state,
  view,
  risk,
  fixture,
  onRetry
}: CockpitDashboardContentProps) {
  if (state.kind === "loading") {
    return (
      <main className="cockpit-page cockpit-state-page" aria-busy="true" aria-label="驾驶舱加载中">
        <section className="cockpit-state-panel">
          <h1>驾驶舱加载中</h1>
          <p>正在读取项目内授权数据。</p>
        </section>
      </main>
    );
  }
  if (state.kind === "denied") {
    return (
      <StatePanel
        title="无权查看项目驾驶舱"
        message="当前身份没有此项目驾驶舱的读取权限。"
        onRetry={onRetry}
      />
    );
  }
  if (state.kind === "error") {
    return (
      <StatePanel
        title="项目驾驶舱暂不可用"
        message={state.message}
        retryable={state.retryable}
        onRetry={onRetry}
      />
    );
  }
  if (state.kind === "not-available") {
    return (
      <StatePanel
        title="尚未生成驾驶舱投影"
        message="当前项目尚无可用的驾驶舱投影。"
        onRetry={onRetry}
      />
    );
  }
  if (!("execution" in state)) {
    return <StatePanel title="项目驾驶舱暂不可用" message={state.message} onRetry={onRetry} />;
  }
  return <DataView projectId={projectId} state={state} view={view} risk={risk} fixture={fixture} />;
}

async function loadState(projectId: string) {
  const sources = await loadCockpitDashboardSources(projectId);
  return buildCockpitDashboardPageState(sources);
}

export function CockpitPageClient({ projectId, initialState }: CockpitPageClientProps) {
  const [state, setState] = useState<CockpitDashboardPageState>(
    initialState ?? { kind: "loading" }
  );
  const searchParams = useSearchParams();
  const view = selectedCockpitView(searchParams.get("view"));
  const fixture = searchParams.get("fixture") ?? undefined;
  const selectedRisk = useMemo(() => {
    const value = searchParams.get("risk");
    if (
      !value ||
      state.kind === "loading" ||
      state.kind === "denied" ||
      state.kind === "error" ||
      state.kind === "not-available"
    )
      return null;
    return selectRiskCell(state, value) ? (value as RiskCellKey) : null;
  }, [searchParams, state]);

  const reload = useCallback(async () => {
    setState({ kind: "loading" });
    setState(await loadState(projectId));
  }, [projectId]);

  useEffect(() => {
    if (initialState) return;
    let cancelled = false;
    void loadState(projectId).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [initialState, projectId]);

  return (
    <CockpitDashboardContent
      projectId={projectId}
      state={state}
      view={view}
      risk={selectedRisk}
      fixture={fixture}
      onRetry={() => void reload()}
    />
  );
}
