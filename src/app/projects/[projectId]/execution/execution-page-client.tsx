"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import {
  buildExecutionPageState,
  type ExecutionFetchResult,
  type ExecutionMilestone,
  type ExecutionResponsibilityPackage,
  type ExecutionTask,
  type PopulatedExecutionState,
  type ProjectExecutionDto
} from "@/modules/planning/contracts/execution-page-state";

type ExecutionPageClientProps = {
  projectId: string;
  initialResult: ExecutionFetchResult | null;
};

type Selection =
  | { kind: "task"; value: ExecutionTask }
  | { kind: "package"; value: ExecutionResponsibilityPackage }
  | { kind: "milestone"; value: ExecutionMilestone }
  | null;

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "草稿",
  ACTIVE: "执行中",
  NOT_STARTED: "未开始",
  IN_PROGRESS: "执行中",
  COMPLETED: "已完成",
  CLOSED: "已关闭",
  GATE_REVIEW: "Gate 待审",
  SUSPENDED: "已挂起",
  CANCELED: "已取消",
  PENDING: "待确认",
  ACHIEVED: "已达成",
  VOID: "已作废",
  OPEN: "开放",
  ACCEPTANCE_PENDING: "待验收",
  ACCEPTED: "已验收",
  SUCCEEDED: "计算完成",
  FAILED: "计算失败",
  RUNNING: "计算中",
  NOT_REQUESTED: "尚未请求预测",
  SUPERSEDED: "预测已被新版本替代"
};

function formatDate(value: string | null) {
  if (!value) return "未设定";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未设定";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
}

function formatTimestamp(value: string | null) {
  if (!value) return "尚无计算结果";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚无计算结果";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function formatWorkdays(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status;
}

function detailSelection(state: PopulatedExecutionState, search: URLSearchParams): Selection {
  const taskId = search.get("task");
  if (taskId) {
    const task = state.tasks.find((candidate) => candidate.taskId === taskId);
    if (task) return { kind: "task", value: task };
  }
  const packageId = search.get("package");
  if (packageId) {
    const responsibilityPackage = state.responsibilityPackages.find(
      (candidate) => candidate.packageId === packageId
    );
    if (responsibilityPackage) return { kind: "package", value: responsibilityPackage };
  }
  const milestoneId = search.get("milestone");
  if (milestoneId) {
    const milestone = state.milestones.find((candidate) => candidate.milestoneId === milestoneId);
    if (milestone) return { kind: "milestone", value: milestone };
  }
  return null;
}

function FetchState({ state, retry }: { state: ExecutionFetchResult; retry: () => void }) {
  const page = buildExecutionPageState(state);
  if (page.kind === "loading") {
    return (
      <main className="execution-page" aria-busy="true" aria-label="项目执行数据加载中">
        <div className="execution-skeleton execution-skeleton-title" />
        <div className="execution-skeleton execution-skeleton-progress" />
        <div className="execution-skeleton-grid">
          <div className="execution-skeleton execution-skeleton-list" />
          <div className="execution-skeleton execution-skeleton-side" />
        </div>
      </main>
    );
  }
  if (page.kind === "denied") {
    return (
      <main className="execution-page execution-state-page">
        <section className="execution-state-panel" aria-labelledby="execution-denied-title">
          <p className="execution-eyebrow">PROJECT EXECUTION</p>
          <h1 id="execution-denied-title">无权查看项目执行信息</h1>
          <p>当前身份没有此项目的读取权限。</p>
        </section>
      </main>
    );
  }
  if (page.kind === "error") {
    return (
      <main className="execution-page execution-state-page">
        <section
          className="execution-state-panel execution-state-error"
          aria-labelledby="execution-error-title"
        >
          <p className="execution-eyebrow">PROJECT EXECUTION</p>
          <h1 id="execution-error-title">执行信息暂不可用</h1>
          <p>{page.message}</p>
          {page.retryable ? (
            <button className="execution-command" type="button" onClick={retry}>
              重新加载
            </button>
          ) : null}
        </section>
      </main>
    );
  }
  if (page.kind === "empty") {
    return (
      <main className="execution-page">
        <header className="execution-header">
          <div>
            <p className="execution-eyebrow">PROJECT EXECUTION</p>
            <h1>{page.project.name}</h1>
            <p className="execution-project-code">{page.project.code}</p>
          </div>
        </header>
        <section className="execution-state-panel" aria-labelledby="execution-empty-title">
          <h2 id="execution-empty-title">暂无有效计划任务</h2>
          <p>当前项目没有参与执行进度计算的任务。</p>
          <p className="execution-meta">计算时间：{formatTimestamp(page.calculatedAt)}</p>
        </section>
      </main>
    );
  }
  return <PopulatedPage state={page} />;
}

function NoticeBand({ state }: { state: PopulatedExecutionState }) {
  if (state.notices.length === 0) return null;
  return (
    <section className="execution-notices" aria-label="执行数据状态">
      {state.notices.map((notice) => {
        if (notice.kind === "STALE") {
          return (
            <p className="execution-notice execution-notice-warning" key={notice.kind}>
              预测结果已过期。最新可用计算：{formatTimestamp(notice.timestamp)}
            </p>
          );
        }
        if (notice.kind === "CALCULATION_PENDING") {
          return (
            <p className="execution-notice execution-notice-info" key={notice.kind}>
              计划预测正在计算，以下任务仍显示最近可用数据。
            </p>
          );
        }
        if (notice.kind === "CALCULATION_FAILED") {
          return (
            <p className="execution-notice execution-notice-error" key={notice.kind}>
              计划预测计算失败：{notice.message}
            </p>
          );
        }
        return (
          <p className="execution-notice execution-notice-muted" key={notice.kind}>
            项目已归档，页面仅供查阅。
          </p>
        );
      })}
    </section>
  );
}

function DetailPanel({ selection }: { selection: Selection }) {
  if (!selection) return null;
  if (selection.kind === "task") {
    const task = selection.value;
    return (
      <section
        className="execution-detail"
        id="execution-detail"
        aria-live="polite"
        aria-label="任务详情"
      >
        <div>
          <p className="execution-detail-kicker">任务详情</p>
          <h2>{task.name}</h2>
          <p>{task.code}</p>
        </div>
        <dl>
          <div>
            <dt>状态</dt>
            <dd>{statusLabel(task.status)}</dd>
          </div>
          <div>
            <dt>计划完成</dt>
            <dd>{formatDate(task.plannedFinishAt)}</dd>
          </div>
          <div>
            <dt>当前预测</dt>
            <dd>{formatDate(task.predictedFinishAt ?? task.forecastFinishAt)}</dd>
          </div>
          <div>
            <dt>负责人</dt>
            <dd>{task.owner.name}</dd>
          </div>
        </dl>
      </section>
    );
  }
  if (selection.kind === "package") {
    const responsibilityPackage = selection.value;
    return (
      <section
        className="execution-detail"
        id="execution-detail"
        aria-live="polite"
        aria-label="责任包详情"
      >
        <div>
          <p className="execution-detail-kicker">责任包详情</p>
          <h2>{responsibilityPackage.name}</h2>
          <p>{responsibilityPackage.code}</p>
        </div>
        <dl>
          <div>
            <dt>状态</dt>
            <dd>{statusLabel(responsibilityPackage.status)}</dd>
          </div>
          <div>
            <dt>有效任务</dt>
            <dd>{responsibilityPackage.effectiveTaskCount}</dd>
          </div>
          <div>
            <dt>验收时间</dt>
            <dd>{formatDate(responsibilityPackage.acceptedAt)}</dd>
          </div>
        </dl>
      </section>
    );
  }
  const milestone = selection.value;
  return (
    <section
      className="execution-detail"
      id="execution-detail"
      aria-live="polite"
      aria-label="里程碑详情"
    >
      <div>
        <p className="execution-detail-kicker">里程碑详情</p>
        <h2>{milestone.name}</h2>
        <p>{milestone.code}</p>
      </div>
      <dl>
        <div>
          <dt>状态</dt>
          <dd>{statusLabel(milestone.status)}</dd>
        </div>
        <div>
          <dt>目标日期</dt>
          <dd>{formatDate(milestone.targetAt)}</dd>
        </div>
        <div>
          <dt>关联任务</dt>
          <dd>{milestone.links.length}</dd>
        </div>
      </dl>
    </section>
  );
}

function PopulatedPage({ state }: { state: PopulatedExecutionState }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const progressPercent = Math.min(100, Math.max(0, state.progress.percent));
  const selection = useMemo(
    () => detailSelection(state, new URLSearchParams(searchParams.toString())),
    [searchParams, state]
  );
  const selectionHref = (kind: "task" | "package" | "milestone", id: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("task");
    next.delete("package");
    next.delete("milestone");
    next.set(kind, id);
    return `${pathname}?${next.toString()}#execution-detail`;
  };
  return (
    <main className="execution-page">
      <header className="execution-header">
        <div>
          <p className="execution-eyebrow">PROJECT EXECUTION</p>
          <h1>{state.project.name}</h1>
          <p className="execution-project-code">{state.project.code}</p>
        </div>
        <div className="execution-header-status">
          <span>{statusLabel(state.project.status)}</span>
          <span>预测：{statusLabel(state.schedule.status)}</span>
        </div>
      </header>
      <NoticeBand state={state} />
      <section className="execution-progress-band" aria-labelledby="execution-progress-title">
        <div>
          <p id="execution-progress-title" className="execution-section-kicker">
            项目进度
          </p>
          <p className="execution-progress-value">{state.progress.percent.toFixed(1)}%</p>
        </div>
        <div
          role="progressbar"
          className="execution-progress-track"
          aria-label={`项目进度 ${state.progress.percent}%`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPercent}
        >
          <span style={{ width: `${progressPercent}%` }} />
        </div>
        <p className="execution-progress-detail">
          已完成 {formatWorkdays(state.progress.completedWorkdays)} 天，共{" "}
          {formatWorkdays(state.progress.totalWorkdays)} 天
        </p>
        <p className="execution-meta">计算时间：{formatTimestamp(state.progress.calculatedAt)}</p>
      </section>
      <section className="execution-workspace" aria-label="项目执行详情">
        <section className="execution-exceptions" aria-labelledby="execution-exceptions-title">
          <div className="execution-section-heading">
            <div>
              <p className="execution-section-kicker">优先处理</p>
              <h2 id="execution-exceptions-title">关键路径异常</h2>
            </div>
            <span>{state.exceptions.length} 项</span>
          </div>
          {state.exceptions.length === 0 ? (
            <p className="execution-empty-inline">当前没有关键路径延期异常。</p>
          ) : (
            <div className="execution-list">
              {state.exceptions.map((exception) => (
                <a
                  className="execution-row execution-row-exception"
                  key={exception.taskId}
                  href={selectionHref("task", exception.taskId)}
                >
                  <span>
                    <strong>{exception.name}</strong>
                    <small>{exception.code}</small>
                  </span>
                  <span className="execution-row-date">
                    计划 {formatDate(exception.plannedFinishAt)}
                    <b>预测 {formatDate(exception.predictedFinishAt)}</b>
                  </span>
                </a>
              ))}
            </div>
          )}
        </section>
        <aside className="execution-milestones" aria-label="下一里程碑与全部里程碑">
          <div className="execution-section-heading">
            <div>
              <p className="execution-section-kicker">下一节点</p>
              <h2>里程碑</h2>
            </div>
          </div>
          {state.nextMilestone ? (
            <a
              className="execution-next-milestone"
              href={selectionHref("milestone", state.nextMilestone!.milestoneId)}
            >
              <span>{state.nextMilestone.name}</span>
              <strong>{formatDate(state.nextMilestone.targetAt)}</strong>
              <small>{state.nextMilestone.code}</small>
            </a>
          ) : (
            <p className="execution-empty-inline">没有待确认里程碑。</p>
          )}
          <div className="execution-milestone-list">
            {state.milestones.map((milestone) => (
              <a
                className="execution-milestone-row"
                key={milestone.milestoneId}
                href={selectionHref("milestone", milestone.milestoneId)}
              >
                <span>{milestone.name}</span>
                <span
                  className={`execution-status execution-status-${milestone.status.toLowerCase()}`}
                >
                  {statusLabel(milestone.status)}
                </span>
              </a>
            ))}
          </div>
        </aside>
        <section className="execution-critical-tasks" aria-labelledby="execution-tasks-title">
          <div className="execution-section-heading">
            <div>
              <p className="execution-section-kicker">计划关注</p>
              <h2 id="execution-tasks-title">关键任务</h2>
            </div>
            <span>{state.criticalTasks.length} 项</span>
          </div>
          <div className="execution-list">
            {state.criticalTasks.map((task) => (
              <a
                className="execution-row"
                key={task.taskId}
                href={selectionHref("task", task.taskId)}
              >
                <span>
                  <strong>{task.name}</strong>
                  <small>{task.responsibilityPackage?.name ?? "未分配责任包"}</small>
                </span>
                <span className="execution-row-date">
                  {statusLabel(task.status)}
                  <b>{formatDate(task.predictedFinishAt ?? task.forecastFinishAt)}</b>
                </span>
              </a>
            ))}
          </div>
        </section>
        <section className="execution-packages" aria-labelledby="execution-packages-title">
          <div className="execution-section-heading">
            <div>
              <p className="execution-section-kicker">责任边界</p>
              <h2 id="execution-packages-title">责任包</h2>
            </div>
            <span>{state.responsibilityPackages.length} 个</span>
          </div>
          <div className="execution-list">
            {state.responsibilityPackages.map((responsibilityPackage) => (
              <a
                className="execution-row"
                key={responsibilityPackage.packageId}
                href={selectionHref("package", responsibilityPackage.packageId)}
              >
                <span>
                  <strong>{responsibilityPackage.name}</strong>
                  <small>{responsibilityPackage.code}</small>
                </span>
                <span className="execution-row-date">
                  {statusLabel(responsibilityPackage.status)}
                  <b>{responsibilityPackage.effectiveTaskCount} 个有效任务</b>
                </span>
              </a>
            ))}
          </div>
        </section>
      </section>
      <DetailPanel selection={selection} />
    </main>
  );
}

async function loadExecution(projectId: string): Promise<ExecutionFetchResult> {
  try {
    const response = await fetch(`/api/projects/${projectId}/execution`, { cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as
      ProjectExecutionDto | { error?: { message?: string } } | null;
    if (!response.ok) {
      return {
        kind: "error",
        status: response.status,
        message:
          payload && "error" in payload && payload.error?.message
            ? payload.error.message
            : "无法加载项目执行信息。"
      };
    }
    return { kind: "success", data: payload as ProjectExecutionDto };
  } catch {
    return { kind: "error", status: 503, message: "网络连接不可用，请稍后重试。" };
  }
}

export function ExecutionPageClient({ projectId, initialResult }: ExecutionPageClientProps) {
  const [result, setResult] = useState<ExecutionFetchResult>(initialResult ?? { kind: "loading" });
  const reload = useCallback(async () => setResult(await loadExecution(projectId)), [projectId]);

  useEffect(() => {
    if (initialResult) return;
    let cancelled = false;
    async function loadInitialExecution() {
      const next = await loadExecution(projectId);
      if (!cancelled) setResult(next);
    }
    void loadInitialExecution();
    return () => {
      cancelled = true;
    };
  }, [initialResult, projectId]);

  return <FetchState state={result} retry={() => void reload()} />;
}
