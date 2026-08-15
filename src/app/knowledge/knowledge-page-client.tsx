"use client";
import { useCallback, useEffect, useRef, useState } from "react";

type CommandKind = "SUCCESS" | "CONFLICT" | "DENIED" | "UNAVAILABLE" | "ERROR";
type CommandResult = {
  kind: CommandKind;
  code: string | null;
  message: string | null;
  preserveInput: boolean;
  idempotencyKey: string;
  payload: unknown;
};

export async function executeKnowledgeCommand(input: {
  fetcher: typeof fetch;
  endpoint: string;
  body: unknown;
  idempotencyKey: string;
  reload: () => Promise<void>;
}): Promise<CommandResult> {
  try {
    const response = await input.fetcher(input.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey },
      body: JSON.stringify(input.body)
    });
    const payload = await response.json().catch(() => null);
    if (response.ok) {
      await input.reload();
      return {
        kind: "SUCCESS",
        code: null,
        message: null,
        preserveInput: false,
        idempotencyKey: input.idempotencyKey,
        payload
      };
    }
    const error =
      payload && typeof payload === "object" ? (payload as { error?: unknown }).error : null;
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
    const message =
      error && typeof error === "object" ? (error as { message?: unknown }).message : null;
    return {
      kind:
        response.status === 409
          ? "CONFLICT"
          : response.status === 403
            ? "DENIED"
            : response.status === 503
              ? "UNAVAILABLE"
              : "ERROR",
      code: typeof code === "string" ? code : null,
      message: typeof message === "string" ? message : null,
      preserveInput: true,
      idempotencyKey: input.idempotencyKey,
      payload
    };
  } catch {
    return {
      kind: "ERROR",
      code: null,
      message: "命令请求失败，请检查网络后重试。",
      preserveInput: true,
      idempotencyKey: input.idempotencyKey,
      payload: null
    };
  }
}
export type KnowledgeItem = {
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
export type KnowledgeState = {
  status: "NORMAL" | "LOADING" | "EMPTY" | "ERROR" | "DENIED" | "STALE";
  allowedActions: string[];
  capability: "TRIGRAM" | "DEGRADED" | null;
  warningCode: "SEARCH_DEGRADED" | null;
  items: KnowledgeItem[];
};

type KnowledgeCommandRequest = { endpoint: string; body: Record<string, unknown> };

export function buildKnowledgeCommandRequest(
  input:
    | { action: "CREATE"; body: Record<string, unknown> }
    | {
        action: "SUBMIT";
        entryId: string;
        versionId: string;
        expectedEntryVersion: number;
      }
    | {
        action: "PUBLISH";
        entryId: string;
        versionId: string;
        expectedEntryVersion: number;
        reason: string;
      }
    | {
        action: "REUSE";
        targetProjectId: string;
        targetDeliveryUnitId: string | null;
        entryCode: string;
        version: number;
        scenario: string;
        evidenceSummary: string;
      }
    | {
        action: "CORRECTION";
        targetProjectId: string;
        reuseId: string;
        expectedReuseVersion: number;
        correctionType: "TEXT_CORRECTION" | "USAGE_WITHDRAWN" | "SCOPE_CORRECTION";
        reason: string;
        correctionText: string;
      }
): KnowledgeCommandRequest {
  switch (input.action) {
    case "CREATE":
      return { endpoint: "/api/knowledge", body: input.body };
    case "SUBMIT":
      return {
        endpoint: `/api/knowledge/${encodeURIComponent(input.entryId)}/versions/${encodeURIComponent(input.versionId)}/submit`,
        body: { expectedEntryVersion: input.expectedEntryVersion }
      };
    case "PUBLISH":
      return {
        endpoint: `/api/knowledge/${encodeURIComponent(input.entryId)}/versions/${encodeURIComponent(input.versionId)}/reviews`,
        body: {
          expectedEntryVersion: input.expectedEntryVersion,
          decision: "PUBLISH",
          reason: input.reason,
          ipConfirmed: true,
          sanitizationConfirmed: true
        }
      };
    case "REUSE":
      return {
        endpoint: `/api/projects/${encodeURIComponent(input.targetProjectId)}/knowledge-reuse`,
        body: {
          targetDeliveryUnitId: input.targetDeliveryUnitId,
          entryCode: input.entryCode,
          version: input.version,
          scenario: input.scenario,
          evidenceSummary: input.evidenceSummary
        }
      };
    case "CORRECTION":
      return {
        endpoint: `/api/projects/${encodeURIComponent(input.targetProjectId)}/knowledge-reuse/${encodeURIComponent(input.reuseId)}/corrections`,
        body: {
          expectedReuseVersion: input.expectedReuseVersion,
          correctionType: input.correctionType,
          reason: input.reason,
          correctionText: input.correctionText
        }
      };
  }
}

type KnowledgeLoadResult =
  { state: KnowledgeState; message: null } | { state: KnowledgeState; message: string };

const emptyKnowledgeState: KnowledgeState = {
  status: "LOADING",
  allowedActions: [],
  capability: null,
  warningCode: null,
  items: []
};

export function shouldLoadInitialKnowledgeState(input: {
  hasInitialState: boolean;
  hasLoaded: boolean;
}): boolean {
  return !input.hasInitialState && !input.hasLoaded;
}

function errorKnowledgeState(status: KnowledgeState["status"]): KnowledgeState {
  return { ...emptyKnowledgeState, status };
}

function responseKnowledgeState(body: unknown): KnowledgeState | null {
  if (!body || typeof body !== "object") return null;
  const response = body as {
    pageState?: unknown;
    capability?: unknown;
    warningCode?: unknown;
    items?: unknown;
  };
  const pageState = response.pageState;
  if (!pageState || typeof pageState !== "object") return null;
  const candidate = pageState as { status?: unknown; allowedActions?: unknown };
  if (
    !["NORMAL", "LOADING", "EMPTY", "ERROR", "DENIED", "STALE"].includes(
      String(candidate.status)
    ) ||
    !Array.isArray(candidate.allowedActions) ||
    candidate.allowedActions.some(
      (action) => action !== "CREATE" && action !== "CONFIRM_REUSE" && action !== "CORRECT_REUSE"
    ) ||
    !Array.isArray(response.items)
  ) {
    return null;
  }
  return {
    status: candidate.status as KnowledgeState["status"],
    allowedActions: candidate.allowedActions as KnowledgeState["allowedActions"],
    capability:
      response.capability === "TRIGRAM" || response.capability === "DEGRADED"
        ? response.capability
        : null,
    warningCode: response.warningCode === "SEARCH_DEGRADED" ? response.warningCode : null,
    items: response.items as KnowledgeItem[]
  };
}

export async function loadKnowledgePageState(input: {
  fetcher: typeof fetch;
  query: string;
  targetProjectId: string | null;
  reuseId: string | null;
}): Promise<KnowledgeLoadResult> {
  const params = new URLSearchParams();
  const query = input.query.trim();
  if (query) params.set("query", query);
  else params.set("view", "PAGE_STATE");
  if (input.targetProjectId?.trim()) params.set("targetProjectId", input.targetProjectId.trim());
  if (input.reuseId?.trim()) params.set("reuseId", input.reuseId.trim());

  try {
    const response = await input.fetcher(`/api/knowledge?${params.toString()}`, {
      cache: "no-store"
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        state: errorKnowledgeState(
          response.status === 403 ? "DENIED" : response.status === 409 ? "STALE" : "ERROR"
        ),
        message: "服务器未能提供当前知识页面状态。"
      };
    }
    const state = responseKnowledgeState(body);
    if (!state) {
      return {
        state: errorKnowledgeState("ERROR"),
        message: "服务器返回的知识页面状态无效。"
      };
    }
    return { state, message: null };
  } catch {
    return {
      state: errorKnowledgeState("ERROR"),
      message: "知识页面状态请求失败，请检查网络后重试。"
    };
  }
}
type KnowledgeAuthoringContext = {
  entryId: string;
  versionId: string;
  expectedEntryVersion: number;
};

function textValue(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}

function csvValues(form: FormData, name: string): string[] {
  return textValue(form, name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function newIdempotencyKey(operation: string): string {
  const nonce = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `apm104-${operation}-${nonce}`;
}

function authoringContextFromPayload(payload: unknown): KnowledgeAuthoringContext | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  return typeof record.entryId === "string" &&
    typeof record.versionId === "string" &&
    Number.isSafeInteger(record.entryVersion) &&
    (record.entryVersion as number) > 0
    ? {
        entryId: record.entryId,
        versionId: record.versionId,
        expectedEntryVersion: record.entryVersion as number
      }
    : null;
}

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
  const [targetProjectId, setTargetProjectId] = useState("");
  const [reuseId, setReuseId] = useState("");
  const [authoring, setAuthoring] = useState<KnowledgeAuthoringContext | null>(null);
  const [idempotencyKeys, setIdempotencyKeys] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const initialLoad = useRef(false);
  const reload = useCallback(
    async (overrides?: { targetProjectId?: string; reuseId?: string }) => {
      const result = await loadKnowledgePageState({
        fetcher: fetch,
        query,
        targetProjectId: (overrides?.targetProjectId ?? targetProjectId) || null,
        reuseId: (overrides?.reuseId ?? reuseId) || null
      });
      setState(result.state);
      if (result.message) {
        setMessage(result.message);
        throw new Error(result.message);
      }
      setMessage(null);
    },
    [query, reuseId, targetProjectId]
  );
  useEffect(() => {
    if (
      !shouldLoadInitialKnowledgeState({
        hasInitialState: Boolean(initialState),
        hasLoaded: initialLoad.current
      })
    ) {
      return;
    }
    initialLoad.current = true;
    void reload().catch(() => undefined);
  }, [initialState, reload]);

  const runCommand = useCallback(
    async (
      operation: string,
      request: KnowledgeCommandRequest,
      afterSuccess?: (payload: unknown) => void
    ) => {
      const idempotencyKey = idempotencyKeys[operation] ?? newIdempotencyKey(operation);
      if (!idempotencyKeys[operation]) {
        setIdempotencyKeys((keys) => ({ ...keys, [operation]: idempotencyKey }));
      }
      const result = await executeKnowledgeCommand({
        fetcher: fetch,
        endpoint: request.endpoint,
        body: request.body,
        idempotencyKey,
        reload
      });
      if (result.kind === "SUCCESS") {
        setIdempotencyKeys((keys) => {
          const { [operation]: _discarded, ...remaining } = keys;
          return remaining;
        });
        afterSuccess?.(result.payload);
        setMessage("命令已由服务器确认，并已刷新当前页面状态。");
        return result;
      }
      setMessage(
        result.kind === "CONFLICT"
          ? `${result.code ?? "CONFLICT"}：${result.message ?? "服务器状态已变化。"} 输入和幂等键已保留。`
          : `${result.code ?? result.kind}：${result.message ?? "命令未被服务器接受。"}`
      );
      return result;
    },
    [idempotencyKeys, reload]
  );

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
        {message ? <p role="alert">{message}</p> : null}
        {state.status !== "LOADING" ? (
          <button type="button" onClick={() => void reload().catch(() => undefined)}>
            刷新服务器状态
          </button>
        ) : null}
      </main>
    );
  return (
    <main className="knowledge-page" data-state={state.status}>
      <h1>内部知识检索</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void reload().catch(() => undefined);
        }}
      >
        <label>
          检索关键词
          <input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={64} />
        </label>
        <button type="submit">检索</button>
      </form>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const nextTargetProjectId = textValue(form, "target-project");
          const nextReuseId = textValue(form, "reuse-record");
          setTargetProjectId(nextTargetProjectId);
          setReuseId(nextReuseId);
          void reload({ targetProjectId: nextTargetProjectId, reuseId: nextReuseId }).catch(
            () => undefined
          );
        }}
      >
        <label>
          目标项目上下文
          <input name="target-project" defaultValue={targetProjectId} maxLength={191} />
        </label>
        <label>
          已有复用记录（更正时填写）
          <input name="reuse-record" defaultValue={reuseId} maxLength={191} />
        </label>
        <button type="submit">验证目标项目权限</button>
      </form>
      {state.warningCode === "SEARCH_DEGRADED" ? <p role="status">检索处于受限模式</p> : null}
      {message ? <p role="alert">{message}</p> : null}
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
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const request = buildKnowledgeCommandRequest({
                action: "CREATE",
                body: {
                  code: textValue(form, "code"),
                  sourceProjectId: textValue(form, "context-project"),
                  finalArchiveVersionId: textValue(form, "context-final"),
                  retrospectiveInputArchiveVersionId: textValue(form, "context-input"),
                  retrospectiveVersionId: textValue(form, "context-review"),
                  issueHistoryIds: csvValues(form, "context-issues"),
                  expectedEntryVersion: null,
                  draft: {
                    title: textValue(form, "title"),
                    sanitizedSummary: textValue(form, "summary"),
                    experienceType: textValue(form, "experience-type"),
                    discipline: textValue(form, "discipline"),
                    keywords: csvValues(form, "keywords"),
                    applicableProjectTypes: csvValues(form, "project-types"),
                    applicableStageCodes: csvValues(form, "stage-codes"),
                    preconditions: textValue(form, "preconditions"),
                    recommendedPractice: textValue(form, "recommended-practice"),
                    antiPatterns: textValue(form, "anti-patterns"),
                    limitations: textValue(form, "limitations"),
                    ipSanitizationDeclaration: textValue(form, "ip-declaration"),
                    internalReusable: form.get("internal-reusable") === "on"
                  }
                }
              });
              void runCommand("knowledge-create", request, (payload) => {
                const context = authoringContextFromPayload(payload);
                if (context) setAuthoring(context);
              });
            }}
          >
            <h2>创建知识草稿</h2>
            <label>
              知识编码
              <input name="code" maxLength={64} required />
            </label>
            <label>
              来源项目
              <input name="context-project" maxLength={191} required />
            </label>
            <label>
              最终归档
              <input name="context-final" maxLength={191} required />
            </label>
            <label>
              复盘输入归档
              <input name="context-input" maxLength={191} required />
            </label>
            <label>
              已批准复盘版本
              <input name="context-review" maxLength={191} required />
            </label>
            <label>
              问题历史（逗号分隔）
              <input name="context-issues" maxLength={4096} />
            </label>
            <label>
              标题
              <input name="title" maxLength={256} required />
            </label>
            <label>
              脱敏摘要
              <textarea name="summary" maxLength={4096} required />
            </label>
            <label>
              经验类型
              <input name="experience-type" maxLength={64} required />
            </label>
            <label>
              专业
              <input name="discipline" maxLength={64} required />
            </label>
            <label>
              关键词（逗号分隔）
              <input name="keywords" maxLength={4096} required />
            </label>
            <label>
              适用项目类型（逗号分隔）
              <input name="project-types" maxLength={4096} />
            </label>
            <label>
              适用阶段（逗号分隔）
              <input name="stage-codes" maxLength={4096} />
            </label>
            <label>
              前提条件
              <textarea name="preconditions" maxLength={16384} required />
            </label>
            <label>
              推荐做法
              <textarea name="recommended-practice" maxLength={16384} required />
            </label>
            <label>
              反模式
              <textarea name="anti-patterns" maxLength={16384} required />
            </label>
            <label>
              限制条件
              <textarea name="limitations" maxLength={16384} required />
            </label>
            <label>
              知识产权与脱敏声明
              <textarea name="ip-declaration" maxLength={16384} required />
            </label>
            <label>
              <input name="internal-reusable" type="checkbox" />
              允许内部复用
            </label>
            <button type="submit">提交知识草稿</button>
          </form>
        ) : null}
        {authoring ? (
          <section aria-label="知识草稿后续操作">
            <h2>知识草稿已由服务器创建</h2>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void runCommand(
                  "knowledge-submit",
                  buildKnowledgeCommandRequest({ action: "SUBMIT", ...authoring }),
                  (payload) => {
                    const context = authoringContextFromPayload(payload);
                    if (context) setAuthoring(context);
                  }
                );
              }}
            >
              <button type="submit">提交草稿审核</button>
            </form>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void runCommand(
                  "knowledge-publish",
                  buildKnowledgeCommandRequest({
                    action: "PUBLISH",
                    ...authoring,
                    reason: textValue(form, "publish-reason")
                  })
                );
              }}
            >
              <label>
                发布审核理由
                <textarea name="publish-reason" maxLength={4096} required />
              </label>
              <button type="submit">审核并发布知识</button>
            </form>
          </section>
        ) : null}
        {state.allowedActions.includes("CONFIRM_REUSE") ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void runCommand(
                "knowledge-reuse",
                buildKnowledgeCommandRequest({
                  action: "REUSE",
                  targetProjectId,
                  targetDeliveryUnitId: textValue(form, "target-delivery-unit") || null,
                  entryCode: textValue(form, "entry-code"),
                  version: Number(textValue(form, "public-version")),
                  scenario: textValue(form, "reuse-scenario"),
                  evidenceSummary: textValue(form, "reuse-evidence")
                }),
                (payload) => {
                  if (
                    payload &&
                    typeof payload === "object" &&
                    typeof (payload as { id?: unknown }).id === "string"
                  ) {
                    setReuseId((payload as { id: string }).id);
                  }
                }
              );
            }}
          >
            <h2>确认复用</h2>
            <label>
              公开知识编码
              <input name="entry-code" maxLength={64} required />
            </label>
            <label>
              公开版本号
              <input name="public-version" type="number" min={1} required />
            </label>
            <label>
              目标交付单元（可选）
              <input name="target-delivery-unit" maxLength={191} />
            </label>
            <label>
              采用场景
              <textarea name="reuse-scenario" maxLength={4096} required />
            </label>
            <label>
              人工确认依据
              <textarea name="reuse-evidence" maxLength={4096} required />
            </label>
            <button type="submit">确认采用</button>
          </form>
        ) : null}
        {state.allowedActions.includes("CORRECT_REUSE") ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void runCommand(
                "knowledge-correction",
                buildKnowledgeCommandRequest({
                  action: "CORRECTION",
                  targetProjectId,
                  reuseId,
                  expectedReuseVersion: Number(textValue(form, "expected-reuse-version")),
                  correctionType: textValue(form, "correction-type") as
                    "TEXT_CORRECTION" | "USAGE_WITHDRAWN" | "SCOPE_CORRECTION",
                  reason: textValue(form, "correction-reason"),
                  correctionText: textValue(form, "correction-text")
                })
              );
            }}
          >
            <h2>更正复用记录</h2>
            <label>
              当前记录版本
              <input name="expected-reuse-version" type="number" min={1} required />
            </label>
            <label>
              更正类型
              <select name="correction-type" defaultValue="TEXT_CORRECTION">
                <option value="TEXT_CORRECTION">文本更正</option>
                <option value="USAGE_WITHDRAWN">撤回采用</option>
                <option value="SCOPE_CORRECTION">范围更正</option>
              </select>
            </label>
            <label>
              更正理由
              <textarea name="correction-reason" maxLength={4096} required />
            </label>
            <label>
              更正内容
              <textarea name="correction-text" maxLength={4096} required />
            </label>
            <button type="submit">提交更正</button>
          </form>
        ) : null}
      </div>
      {message?.includes("CONFLICT") ? (
        <button type="button" onClick={() => void reload().catch(() => undefined)}>
          刷新服务器状态后重新提交
        </button>
      ) : null}
    </main>
  );
}
