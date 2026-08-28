"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildArchivePageState,
  type ArchivePageState
} from "@/modules/archives/contracts/archive-page-state";

async function readState(projectId: string, actions: string[]): Promise<ArchivePageState> {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/archive`, {
      cache: "no-store"
    });
    const body = await response.json().catch(() => undefined);
    return buildArchivePageState({
      projectId,
      result: {
        status: response.ok && body === undefined ? 502 : response.status,
        body,
        fetchedAt: new Date().toISOString()
      },
      allowedActions: actions
    });
  } catch {
    return buildArchivePageState({ projectId, result: { status: 0 }, allowedActions: actions });
  }
}

export function ArchivePageClient({
  projectId,
  initialState
}: {
  projectId: string;
  initialState: ArchivePageState | null;
}) {
  const [state, setState] = useState<ArchivePageState>(
    initialState ?? { projectId, status: "loading" }
  );
  const stateRef = useRef(state);
  const [message, setMessage] = useState<string | null>(null);
  const [g9SubmissionId, setG9SubmissionId] = useState("");
  const [closeVersion, setCloseVersion] = useState("");
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const reload = useCallback(async () => {
    const current = stateRef.current;
    const allowedActions =
      current.status === "ready" || current.status === "stale" || current.status === "empty"
        ? current.allowedActions
        : [];
    setState(await readState(projectId, allowedActions));
  }, [projectId]);
  useEffect(() => {
    if (initialState === null) void reload();
  }, [initialState, reload]);
  const command = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      setMessage(null);
      try {
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify(body)
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          setMessage(
            payload?.error?.message ??
              (response.status === 409 ? "归档事实已变化，请刷新后重试。" : "归档命令未完成。")
          );
          return;
        }
        setMessage("命令已提交，将在受控 Worker 中完成。 ");
        await reload();
      } catch {
        setMessage("无法连接归档服务，请稍后重试。 ");
      }
    },
    [reload]
  );
  if (state.status === "loading")
    return (
      <main className="archive-page">
        <p role="status">正在读取项目结项归档…</p>
      </main>
    );
  if (state.status === "denied")
    return (
      <main className="archive-page">
        <h1>项目结项归档</h1>
        <p role="alert">无权查看项目结项归档。</p>
      </main>
    );
  if (state.status === "error")
    return (
      <main className="archive-page">
        <h1>项目结项归档</h1>
        <p role="alert">归档数据暂时不可用。</p>
        {state.retryable ? (
          <button type="button" onClick={() => void reload()}>
            重试
          </button>
        ) : null}
      </main>
    );
  const versions =
    state.status === "empty"
      ? []
      : Array.isArray(state.archive.versions)
        ? (state.archive.versions as Array<Record<string, any>>)
        : [];
  const actions = state.status === "empty" ? state.allowedActions : state.allowedActions;
  return (
    <main className="archive-page" aria-label="项目结项归档">
      <header className="archive-context-band">
        <div>
          <p>PROJECT CLOSURE ARCHIVE</p>
          <h1>结项归档</h1>
          <p>
            {state.status === "stale"
              ? "来源事实已过期，须重新生成后才能用于 G9。"
              : "归档清单冻结确切版本，完整性检查读取对象存储的实际字节。"}
          </p>
        </div>
        <p>读取时间：{state.status === "empty" ? "—" : (state.fetchedAt ?? "—")}</p>
      </header>
      {message ? <p role="alert">{message}</p> : null}
      {versions.length === 0 ? (
        <p>尚未生成归档版本；不会以空清单伪装为已完成。</p>
      ) : (
        <ol className="archive-version-list">
          {versions.map((version) => (
            <li key={String(version.id)}>
              <h2>归档版本 V{String(version.version)}</h2>
              <dl>
                <div>
                  <dt>状态</dt>
                  <dd>{String(version.status)}</dd>
                </div>
                <div>
                  <dt>清单项</dt>
                  <dd>{String(version.itemCount)}</dd>
                </div>
                <div>
                  <dt>完整性</dt>
                  <dd>{String(version.latestIntegrityCheck?.status ?? "未检查")}</dd>
                </div>
                <div>
                  <dt>manifest SHA-256</dt>
                  <dd>
                    <code>{String(version.manifestChecksum)}</code>
                  </dd>
                </div>
                <div>
                  <dt>source watermark</dt>
                  <dd>
                    <code>{String(version.sourceWatermark)}</code>
                  </dd>
                </div>
              </dl>
              {actions.includes("RECHECK") &&
              ["READY", "FAILED"].includes(String(version.status)) ? (
                <button
                  type="button"
                  onClick={() =>
                    void command(
                      `/api/projects/${encodeURIComponent(projectId)}/archive/${encodeURIComponent(String(version.id))}/recheck`,
                      { version: Number(version.version) }
                    )
                  }
                >
                  重新检查完整性
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {actions.includes("GENERATE") ? (
        <button
          className="archive-command"
          type="button"
          onClick={() =>
            void command(`/api/projects/${encodeURIComponent(projectId)}/archive/generate`, {
              version: 1
            })
          }
        >
          生成新的归档版本
        </button>
      ) : null}
      {actions.includes("CLOSE") && versions.length > 0 ? (
        <form
          className="archive-close-form"
          onSubmit={(event) => {
            event.preventDefault();
            const version = Number(closeVersion);
            const selected =
              versions.find((item) => String(item.version) === closeVersion) ?? versions[0];
            void command(`/api/projects/${encodeURIComponent(projectId)}/close`, {
              archiveVersionId: String(selected.id),
              g9SubmissionId,
              version
            });
          }}
        >
          <h2>关闭项目</h2>
          <p>
            只有项目级 G9 已批准、归档为 READY
            且遗留项已闭环时才能关闭；服务端会在同一事务中重新校验。
          </p>
          <label>
            G9 提交 ID
            <input
              value={g9SubmissionId}
              onChange={(event) => setG9SubmissionId(event.target.value)}
              required
            />
          </label>
          <label>
            项目版本
            <input
              type="number"
              min="1"
              value={closeVersion}
              onChange={(event) => setCloseVersion(event.target.value)}
              required
            />
          </label>
          <button
            className="archive-command"
            type="submit"
            disabled={!g9SubmissionId || !closeVersion}
          >
            关闭项目
          </button>
        </form>
      ) : null}
    </main>
  );
}
