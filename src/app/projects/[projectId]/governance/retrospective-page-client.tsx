"use client";

import { useCallback, useEffect, useState } from "react";

type ArchiveFacts = {
  id: string;
  status: string;
  manifestChecksum?: string;
  sourceWatermark?: string;
  retrospectiveInputWatermark?: string;
};
type RetrospectiveState = {
  projectId: string;
  status: "NORMAL" | "LOADING" | "EMPTY" | "ERROR" | "DENIED" | "STALE";
  allowedActions: string[];
  archiveA: ArchiveFacts | null;
  archiveB: ArchiveFacts | null;
  currentVersion: { id: string; status: string } | null;
  latestApprovedVersion: { id: string; status: string } | null;
  g9Approval: { submissionId: string; status: "APPROVED" } | null;
  projectStatus?: string;
};
const unavailable = "不可用/未提供";
function Fact({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value ?? unavailable}</dd>
    </div>
  );
}
function archiveFacts(label: string, archive: ArchiveFacts | null) {
  return (
    <section className="governance-facts">
      <h2>{label}</h2>
      {archive ? (
        <dl>
          <Fact label="清单校验和" value={archive.manifestChecksum} />
          <Fact label="来源水位" value={archive.sourceWatermark} />
          <Fact label="复盘输入水位" value={archive.retrospectiveInputWatermark} />
        </dl>
      ) : (
        <p>无可用的确切归档事实。</p>
      )}
    </section>
  );
}
export function RetrospectivePageClient({
  projectId,
  initialState
}: {
  projectId: string;
  initialState?: RetrospectiveState;
}) {
  const [state, setState] = useState<RetrospectiveState>(
    initialState ?? {
      projectId,
      status: "LOADING",
      allowedActions: [],
      archiveA: null,
      archiveB: null,
      currentVersion: null,
      latestApprovedVersion: null,
      g9Approval: null
    }
  );
  const [message, setMessage] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/retrospectives`,
        { cache: "no-store" }
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setState((s) => ({
          ...s,
          status: response.status === 403 ? "DENIED" : response.status === 409 ? "STALE" : "ERROR"
        }));
        return;
      }
      setState(body as RetrospectiveState);
    } catch {
      setState((s) => ({ ...s, status: "ERROR" }));
    }
  }, [projectId]);
  useEffect(() => {
    if (initialState) return;
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [initialState, reload]);
  const can = (action: string) =>
    state.projectStatus !== "CLOSED" && state.allowedActions.includes(action);
  if (state.status !== "NORMAL" && state.status !== "EMPTY" && state.status !== "STALE")
    return (
      <main className="governance-page" data-state={state.status}>
        <h1>项目复盘与关项记录</h1>
        <p role={state.status === "LOADING" ? "status" : "alert"}>
          {state.status === "LOADING"
            ? "正在读取服务器复盘状态。"
            : state.status === "DENIED"
              ? "无权查看项目复盘。"
              : "复盘状态暂时不可用。"}
        </p>
      </main>
    );
  return (
    <main className="governance-page" data-state={state.status}>
      <header>
        <p className="eyebrow">审批与记录</p>
        <h1>项目复盘与关项记录</h1>
      </header>
      {state.status === "EMPTY" ? (
        <p role="status">尚无复盘版本；请按服务器允许的操作创建。</p>
      ) : null}
      {state.projectStatus === "CLOSED" ? (
        <p role="status">项目已关闭，复盘事实不可再修改。</p>
      ) : null}
      {state.status === "STALE" ||
      (state.currentVersion &&
        state.latestApprovedVersion &&
        state.currentVersion.id !== state.latestApprovedVersion.id) ? (
        <p role="alert">当前版本与已批准版本不一致；请刷新并按服务器状态处理。</p>
      ) : null}
      {archiveFacts("归档 A", state.archiveA)}
      {archiveFacts("归档 B", state.archiveB)}
      <section className="governance-facts">
        <h2>G9 与关闭阻断</h2>
        <p>{state.g9Approval ? "G9 已获得服务器确认的批准。" : "G9 尚未获得批准"}</p>
      </section>
      <div className="governance-actions" aria-label="服务器允许的复盘操作">
        {can("CREATE") ? <button type="button">创建复盘</button> : null}
        {can("SUBMIT") ? <button type="button">提交复盘</button> : null}
        {can("REVIEW") ? <button type="button">审核复盘</button> : null}
        {can("GENERATE_ARCHIVE_B") ? <button type="button">生成归档 B</button> : null}
        {can("RUN_G9") ? <button type="button">运行 G9</button> : null}
        {can("CLOSE_PROJECT") && state.g9Approval ? <button type="button">关闭项目</button> : null}
      </div>
      {message ? <p role="alert">{message}</p> : null}
      {state.status === "STALE" ? (
        <button type="button" onClick={() => void reload()}>
          刷新服务器状态
        </button>
      ) : null}
    </main>
  );
}
