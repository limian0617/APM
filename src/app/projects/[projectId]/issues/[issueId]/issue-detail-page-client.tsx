"use client";

import { useCallback, useEffect, useState } from "react";

type IssueDetail = Record<string, unknown>;

export function issueDetailStateLabel(status: "loading" | "ready" | "denied" | "error") {
  return status === "loading"
    ? "问题读取中"
    : status === "ready"
      ? "问题详情"
      : status === "denied"
        ? "无权查看问题"
        : "问题读取暂时不可用";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = "未提供") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function IssueDetailPageClient({
  projectId,
  issueId
}: {
  projectId: string;
  issueId: string;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [issue, setIssue] = useState<IssueDetail | null>(null);

  const loadIssue = useCallback(async () => {
    setStatus("loading");
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}`
    );
    const body = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      setStatus("denied");
      return;
    }
    if (!response.ok || !isRecord(body) || !isRecord(body.issue)) {
      setStatus("error");
      return;
    }
    setIssue(body.issue);
    setStatus("ready");
  }, [issueId, projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadIssue(), 0);
    return () => window.clearTimeout(timer);
  }, [loadIssue]);

  return (
    <main className="issue-detail-page" aria-busy={status === "loading"}>
      <a className="issue-detail-back" href={`/projects/${encodeURIComponent(projectId)}/issues`}>
        返回问题清单
      </a>
      <header className="issue-detail-header">
        <div>
          <p className="issue-capture-eyebrow">PROJECT ISSUE</p>
          <h1>
            {status === "ready" ? text(issue?.title, "问题详情") : issueDetailStateLabel(status)}
          </h1>
        </div>
        <span className="issue-detail-project">项目 {projectId}</span>
      </header>
      {status === "loading" ? <p className="issue-detail-state">正在读取问题详情。</p> : null}
      {status === "denied" ? <p className="issue-detail-state">当前身份无法查看该问题。</p> : null}
      {status === "error" ? (
        <section className="issue-detail-state" aria-live="polite">
          <p>问题读取暂时不可用。</p>
          <button
            type="button"
            className="issue-capture-secondary"
            onClick={() => void loadIssue()}
          >
            重新加载
          </button>
        </section>
      ) : null}
      {status === "ready" && issue ? (
        <>
          <section className="issue-detail-facts" aria-label="问题事实">
            <div>
              <span>状态</span>
              <strong>{text(issue.status)}</strong>
            </div>
            <div>
              <span>严重度</span>
              <strong>{text(issue.severity)}</strong>
            </div>
            <div>
              <span>分类</span>
              <strong>{text(issue.category)}</strong>
            </div>
            <div>
              <span>版本</span>
              <strong>{text(issue.version)}</strong>
            </div>
          </section>
          <section className="issue-detail-section">
            <h2>确认文字</h2>
            <p>{text(issue.confirmedText)}</p>
          </section>
          <section className="issue-detail-section">
            <h2>现象描述</h2>
            <p>{text(issue.phenomenonDescription)}</p>
          </section>
        </>
      ) : null}
    </main>
  );
}
