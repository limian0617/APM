"use client";
import { useCallback, useEffect, useState } from "react";
type Item = {
  entryCode: string;
  version: number;
  title: string;
  sanitizedSummary: string;
  experienceType: string;
  discipline: string;
  keywords: string[];
  applicableProjectTypes: string[];
  applicableStageCodes: string[];
  status: string;
};
type KnowledgeState = {
  status: "NORMAL" | "LOADING" | "EMPTY" | "ERROR" | "DENIED" | "STALE";
  allowedActions: string[];
  capability: "TRIGRAM" | "DEGRADED" | null;
  warningCode: "SEARCH_DEGRADED" | null;
  items: Item[];
};
export function KnowledgePageClient({ initialState }: { initialState?: KnowledgeState }) {
  const [state, setState] = useState<KnowledgeState>(
    initialState ?? {
      status: "LOADING",
      allowedActions: [],
      capability: null,
      warningCode: null,
      items: []
    }
  );
  const [query, setQuery] = useState("");
  const reload = useCallback(async () => {
    if (!query.trim()) return;
    try {
      const r = await fetch(`/api/knowledge?query=${encodeURIComponent(query)}`, {
        cache: "no-store"
      });
      const b = await r.json().catch(() => null);
      if (!r.ok) {
        setState((s) => ({
          ...s,
          status: r.status === 403 ? "DENIED" : r.status === 409 ? "STALE" : "ERROR"
        }));
        return;
      }
      setState({
        status: b.items?.length ? "NORMAL" : "EMPTY",
        allowedActions: [],
        capability: b.capability ?? null,
        warningCode: b.warningCode ?? null,
        items: b.items ?? []
      });
    } catch {
      setState((s) => ({ ...s, status: "ERROR" }));
    }
  }, [query]);
  useEffect(() => {
    if (initialState) return;
    const timer = window.setTimeout(() => setState((s) => ({ ...s, status: "EMPTY" })), 0);
    return () => window.clearTimeout(timer);
  }, [initialState]);
  if (state.status !== "NORMAL" && state.status !== "EMPTY")
    return (
      <main className="knowledge-page" data-state={state.status}>
        <h1>内部知识检索</h1>
        <p role={state.status === "LOADING" ? "status" : "alert"}>
          {state.status === "DENIED"
            ? "无权查看内部知识。"
            : state.status === "STALE"
              ? "知识状态已过期，请刷新。"
              : "知识服务暂时不可用。"}
        </p>
      </main>
    );
  return (
    <main className="knowledge-page" data-state={state.status}>
      <h1>内部知识检索</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void reload();
        }}
      >
        <label>
          检索关键词
          <input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={64} />
        </label>
        <button type="submit">检索</button>
      </form>
      {state.warningCode === "SEARCH_DEGRADED" ? <p role="status">检索处于受限模式</p> : null}
      {state.status === "EMPTY" ? (
        <p role="status">没有符合条件的已发布知识。</p>
      ) : (
        <ul>
          {state.items.map((i) => (
            <li key={`${i.entryCode}-${i.version}`}>
              <h2>{i.title}</h2>
              <p>{i.sanitizedSummary}</p>
              <p>{i.keywords.join("、")}</p>
            </li>
          ))}
        </ul>
      )}
      <div className="knowledge-actions">
        {state.allowedActions.includes("CREATE") ? (
          <button type="button">创建知识草稿</button>
        ) : null}
        {state.allowedActions.includes("CONFIRM_REUSE") ? (
          <button type="button">确认复用</button>
        ) : null}
        {state.allowedActions.includes("CORRECT_REUSE") ? (
          <button type="button">更正复用</button>
        ) : null}
      </div>
    </main>
  );
}
