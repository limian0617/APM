"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import {
  buildResourceLoadPageState,
  findResourceLoadDiscipline,
  findResourceLoadPerson,
  type ResourceLoadFetchResult,
  type ResourceLoadPageState,
  type ResourceLoadPersonDto,
  type ResourceLoadResponseData
} from "@/modules/cockpit/contracts/resource-load-page-state";

type ResourceLoadPageClientProps = {
  projectId: string;
  initialResult: ResourceLoadFetchResult | null;
};

function formatTimestamp(value: string) {
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

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未设定";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
}

function departmentLabel(departmentId: string) {
  return departmentId === "UNASSIGNED" ? "未分配部门" : departmentId;
}

function drillDownSelection(state: ResourceLoadPageState, search: URLSearchParams) {
  const departmentId = search.get("department");
  const discipline = search.get("discipline");
  const ownerMembershipId = search.get("member");
  if (!departmentId || !discipline || !ownerMembershipId) return null;
  return findResourceLoadPerson(state, { departmentId, discipline, ownerMembershipId });
}

function disciplineSelection(state: ResourceLoadPageState, search: URLSearchParams) {
  const departmentId = search.get("department");
  const discipline = search.get("discipline");
  if (!departmentId || !discipline) return null;
  return findResourceLoadDiscipline(state, { departmentId, discipline });
}

function LoadingPage() {
  return (
    <main className="resource-load-page" aria-busy="true" aria-label="资源负荷加载中">
      <div className="resource-load-skeleton resource-load-skeleton-title" />
      <div className="resource-load-skeleton resource-load-skeleton-band" />
      <div className="resource-load-skeleton resource-load-skeleton-table" />
    </main>
  );
}

function StatePage({
  title,
  children,
  error = false
}: {
  title: string;
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <main className="resource-load-page resource-load-state-page">
      <section
        className={`resource-load-state-panel${error ? " resource-load-state-error" : ""}`}
        aria-labelledby="resource-load-state-title"
      >
        <p className="resource-load-eyebrow">PROJECT COCKPIT / RESOURCE LOAD</p>
        <h1 id="resource-load-state-title">{title}</h1>
        {children}
      </section>
    </main>
  );
}

function PersonDetail({ person }: { person: ResourceLoadPersonDto }) {
  return (
    <section id="resource-load-detail" className="resource-load-detail" aria-label="人员与任务明细">
      <div>
        <p className="resource-load-section-kicker">人员负荷</p>
        <h2>{person.personName}</h2>
        <p className="resource-load-meta">计划负荷 {person.plannedDays} 天</p>
      </div>
      <div className="resource-load-task-list">
        {person.tasks.map((task) => (
          <div className="resource-load-task-row" key={task.taskId}>
            <span>
              <strong>{task.taskName}</strong>
              <small>{task.taskCode}</small>
            </span>
            <span>
              {formatDate(task.plannedStartAt)} — {formatDate(task.plannedFinishAt)}
              <b>{task.plannedDays} 天</b>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function PopulatedPage({
  state
}: {
  state: Extract<ResourceLoadPageState, { kind: "populated" }>;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selection = useMemo(
    () => drillDownSelection(state, new URLSearchParams(searchParams.toString())),
    [searchParams, state]
  );
  const expandedDiscipline = useMemo(
    () => disciplineSelection(state, new URLSearchParams(searchParams.toString())),
    [searchParams, state]
  );
  const rosterHref = (departmentId: string, discipline: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("department", departmentId);
    next.set("discipline", discipline);
    next.delete("member");
    return `${pathname}?${next.toString()}#resource-load-table-title`;
  };
  const detailHref = (departmentId: string, discipline: string, ownerMembershipId: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("department", departmentId);
    next.set("discipline", discipline);
    next.set("member", ownerMembershipId);
    return `${pathname}?${next.toString()}#resource-load-detail`;
  };

  return (
    <main className="resource-load-page">
      <header className="resource-load-header">
        <div>
          <p className="resource-load-eyebrow">PROJECT COCKPIT</p>
          <h1>资源负荷</h1>
          <p className="resource-load-meta">按任务计划日期的整天数计算，不按任务数量或分钟计算。</p>
        </div>
        <p className="resource-load-calculated-at">
          计算时间：{formatTimestamp(state.calculatedAt)}
        </p>
      </header>

      {state.freshness === "STALE" ? (
        <p className="resource-load-notice resource-load-notice-warning" role="status">
          资源负荷数据已过期。以下为最近一次成功计算的计划负荷，请刷新投影后再安排资源。
        </p>
      ) : null}
      {!state.peopleIncluded ? (
        <p className="resource-load-notice resource-load-notice-info">
          你可以查看部门与专业汇总；当前身份没有个人和任务明细读取权限。
        </p>
      ) : null}

      <section className="resource-load-summary" aria-labelledby="resource-load-summary-title">
        <div>
          <p id="resource-load-summary-title" className="resource-load-section-kicker">
            当前计划负荷
          </p>
          <p className="resource-load-summary-value">{state.plannedDays} 天</p>
        </div>
        <p>部门 → 专业{state.peopleIncluded ? " → 人员" : ""}</p>
        <p>来源快照：{state.projectionId}</p>
      </section>

      <section className="resource-load-table-section" aria-labelledby="resource-load-table-title">
        <div className="resource-load-section-heading">
          <div>
            <p className="resource-load-section-kicker">资源协调</p>
            <h2 id="resource-load-table-title">部门与专业负荷</h2>
          </div>
          <span>{state.departments.length} 个部门</span>
        </div>
        <div className="resource-load-table-scroll">
          <table className="resource-load-table">
            <thead>
              <tr>
                <th scope="col">部门</th>
                <th scope="col">专业</th>
                <th scope="col" className="resource-load-number">
                  计划负荷
                </th>
                <th scope="col">人员明细</th>
              </tr>
            </thead>
            <tbody>
              {state.departments.flatMap((department) =>
                department.disciplines.map((discipline, index) => (
                  <tr key={`${department.departmentId}:${discipline.discipline}`}>
                    {index === 0 ? (
                      <th scope="rowgroup" rowSpan={department.disciplines.length}>
                        <span>{departmentLabel(department.departmentId)}</span>
                        <small>{department.plannedDays} 天</small>
                      </th>
                    ) : null}
                    <td>{discipline.discipline}</td>
                    <td className="resource-load-number">{discipline.plannedDays} 天</td>
                    <td>
                      {state.peopleIncluded && discipline.people.length > 0 ? (
                        expandedDiscipline === discipline ? (
                          <div className="resource-load-people-links">
                            {discipline.people.map((person) => (
                              <a
                                href={detailHref(
                                  department.departmentId,
                                  discipline.discipline,
                                  person.ownerMembershipId
                                )}
                                key={person.ownerMembershipId}
                              >
                                {person.personName} · {person.plannedDays} 天
                              </a>
                            ))}
                          </div>
                        ) : (
                          <a
                            className="resource-load-roster-link"
                            href={rosterHref(department.departmentId, discipline.discipline)}
                          >
                            查看 {discipline.people.length} 名人员
                          </a>
                        )
                      ) : (
                        <span className="resource-load-muted">
                          {state.peopleIncluded ? "暂无人员明细" : "无权限"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="resource-load-mobile-list" aria-label="部门与专业负荷列表">
          {state.departments.map((department) => (
            <section
              className="resource-load-mobile-department"
              key={department.departmentId}
              aria-label={`${departmentLabel(department.departmentId)}负荷`}
            >
              <header>
                <h3>{departmentLabel(department.departmentId)}</h3>
                <span>{department.plannedDays} 天</span>
              </header>
              {department.disciplines.map((discipline) => (
                <div
                  className="resource-load-mobile-discipline"
                  key={`${department.departmentId}:${discipline.discipline}`}
                >
                  <div>
                    <h4>{discipline.discipline}</h4>
                    <p>计划负荷 {discipline.plannedDays} 天</p>
                  </div>
                  {state.peopleIncluded && discipline.people.length > 0 ? (
                    expandedDiscipline === discipline ? (
                      <div className="resource-load-people-links">
                        {discipline.people.map((person) => (
                          <a
                            href={detailHref(
                              department.departmentId,
                              discipline.discipline,
                              person.ownerMembershipId
                            )}
                            key={person.ownerMembershipId}
                          >
                            {person.personName} · {person.plannedDays} 天
                          </a>
                        ))}
                      </div>
                    ) : (
                      <a
                        className="resource-load-roster-link"
                        href={rosterHref(department.departmentId, discipline.discipline)}
                      >
                        查看 {discipline.people.length} 名人员
                      </a>
                    )
                  ) : (
                    <span className="resource-load-muted">
                      {state.peopleIncluded ? "暂无人员明细" : "无权限"}
                    </span>
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
      </section>
      {selection ? <PersonDetail person={selection} /> : null}
    </main>
  );
}

function ResourceLoadContent({
  state,
  retry
}: {
  state: ResourceLoadPageState;
  retry: () => void;
}) {
  if (state.kind === "loading") return <LoadingPage />;
  if (state.kind === "denied") {
    return (
      <StatePage title="无权查看资源负荷">
        <p>当前身份没有读取此项目资源负荷的权限。</p>
      </StatePage>
    );
  }
  if (state.kind === "error") {
    return (
      <StatePage title="资源负荷暂不可用" error>
        <p>{state.message}</p>
        {state.retryable ? (
          <button className="resource-load-command" type="button" onClick={retry}>
            重新加载
          </button>
        ) : null}
      </StatePage>
    );
  }
  if (state.kind === "not-available") {
    return (
      <StatePage title="尚未生成资源负荷">
        <p>项目尚无资源负荷投影。拥有计划更新权限的人员可先生成投影。</p>
      </StatePage>
    );
  }
  if (state.kind === "empty") {
    return (
      <StatePage title="暂无当前资源负荷">
        <p>当前投影没有未开始或进行中的计划任务。</p>
        <p>计算时间：{formatTimestamp(state.calculatedAt)}</p>
        {state.freshness === "STALE" ? <p>该空投影已过期，请刷新后确认。</p> : null}
      </StatePage>
    );
  }
  return <PopulatedPage state={state} />;
}

async function loadResourceLoad(projectId: string): Promise<ResourceLoadFetchResult> {
  try {
    const response = await fetch(`/api/projects/${projectId}/cockpit/resource-load`, {
      cache: "no-store"
    });
    const payload = (await response.json().catch(() => null)) as
      ResourceLoadResponseData | { error?: { message?: string } } | null;
    if (!response.ok) {
      return {
        kind: "error",
        status: response.status,
        message:
          payload && "error" in payload && payload.error?.message
            ? payload.error.message
            : "无法加载项目资源负荷。"
      };
    }
    return { kind: "success", data: payload as ResourceLoadResponseData };
  } catch {
    return { kind: "error", status: 503, message: "网络连接不可用，请稍后重试。" };
  }
}

export function ResourceLoadPageClient({ projectId, initialResult }: ResourceLoadPageClientProps) {
  const [result, setResult] = useState<ResourceLoadFetchResult>(
    initialResult ?? { kind: "loading" }
  );
  const reload = useCallback(async () => setResult(await loadResourceLoad(projectId)), [projectId]);

  useEffect(() => {
    if (initialResult) return;
    let cancelled = false;
    async function loadInitialResourceLoad() {
      const next = await loadResourceLoad(projectId);
      if (!cancelled) setResult(next);
    }
    void loadInitialResourceLoad();
    return () => {
      cancelled = true;
    };
  }, [initialResult, projectId]);

  return (
    <ResourceLoadContent state={buildResourceLoadPageState(result)} retry={() => void reload()} />
  );
}
