"use client";

import { useCallback, useEffect, useState } from "react";

type CommandKind = "SUCCESS" | "CONFLICT" | "DENIED" | "UNAVAILABLE" | "ERROR";
type CommandResult = {
  kind: CommandKind;
  code: string | null;
  message: string | null;
  preserveInput: boolean;
  idempotencyKey: string;
  payload: unknown;
};

export async function executeRetrospectiveCommand(input: {
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

type ArchiveFacts = {
  id: string;
  status: string;
  manifestChecksum?: string;
  sourceWatermark?: string;
  retrospectiveInputWatermark?: string;
};
type RetrospectiveState = {
  projectId: string;
  projectStatus: string;
  projectVersion: number;
  aggregateVersion: number | null;
  status: "NORMAL" | "LOADING" | "EMPTY" | "ERROR" | "DENIED" | "STALE";
  allowedActions: string[];
  archiveA: ArchiveFacts | null;
  archiveB: ArchiveFacts | null;
  currentVersion: { id: string; status: string } | null;
  latestApprovedVersion: { id: string; status: string } | null;
  g9Approval: { submissionId: string; status: "APPROVED" } | null;
  g9Workflow: {
    instanceId: string;
    instanceVersion: number;
    submission: { id: string; version: number; status: string } | null;
    canRunChecks: boolean;
    canSubmit: boolean;
    canApprove: boolean;
  } | null;
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

function commandKey(operation: string) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${operation}-${suffix}`;
}

function commaSeparated(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
      projectStatus: "UNKNOWN",
      projectVersion: 0,
      aggregateVersion: null,
      status: "LOADING",
      allowedActions: [],
      archiveA: null,
      archiveB: null,
      currentVersion: null,
      latestApprovedVersion: null,
      g9Approval: null,
      g9Workflow: null
    }
  );
  const [message, setMessage] = useState<string | null>(null);
  const [idempotencyKeys, setIdempotencyKeys] = useState<Record<string, string>>({});
  const [createDraft, setCreateDraft] = useState({
    deliverySummary: "",
    successfulPractices: "",
    shortcomings: "",
    improvements: "",
    knowledgeDisposition: "",
    ipDeclaration: "",
    participantMembershipIds: "",
    issueHistoryIds: ""
  });
  const [reviewDecision, setReviewDecision] = useState<"APPROVED" | "REJECTED">("APPROVED");
  const [reviewReason, setReviewReason] = useState("");
  const [gateReason, setGateReason] = useState("");
  const [closeOperationId, setCloseOperationId] = useState("");
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
  const run = useCallback(
    async (operation: string, endpoint: string, body: unknown) => {
      const idempotencyKey = idempotencyKeys[operation] ?? commandKey(operation);
      if (!idempotencyKeys[operation]) {
        setIdempotencyKeys((current) => ({ ...current, [operation]: idempotencyKey }));
      }
      const result = await executeRetrospectiveCommand({
        fetcher: fetch,
        endpoint,
        body,
        idempotencyKey,
        reload
      });
      if (result.kind === "SUCCESS") {
        setIdempotencyKeys((current) => {
          const { [operation]: _completed, ...remaining } = current;
          return remaining;
        });
        setMessage("命令已由服务器接受，页面已重新读取最新状态。");
      } else if (result.kind === "CONFLICT") {
        setMessage(
          `${result.code ?? "CONFLICT"}：${result.message ?? "服务器状态已变化。"} 已保留输入，可刷新后重新提交。`
        );
      } else {
        setMessage(`${result.code ?? result.kind}：${result.message ?? "服务器拒绝该命令。"}`);
      }
      return result;
    },
    [idempotencyKeys, reload]
  );
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
      <section className="governance-actions" aria-label="服务器允许的复盘操作">
        {can("CREATE") && state.archiveA ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                `retrospective-create-${state.archiveA!.id}`,
                `/api/projects/${encodeURIComponent(projectId)}/retrospectives`,
                {
                  archiveVersionId: state.archiveA!.id,
                  expectedAggregateVersion: state.aggregateVersion,
                  content: {
                    deliverySummary: createDraft.deliverySummary,
                    successfulPractices: createDraft.successfulPractices,
                    shortcomings: createDraft.shortcomings,
                    improvements: createDraft.improvements,
                    knowledgeDisposition: createDraft.knowledgeDisposition,
                    ipDeclaration: createDraft.ipDeclaration
                  },
                  contributions: [],
                  participantMembershipIds: commaSeparated(createDraft.participantMembershipIds),
                  issueHistoryIds: commaSeparated(createDraft.issueHistoryIds)
                }
              );
            }}
          >
            <h2>创建复盘</h2>
            {(
              [
                ["deliverySummary", "交付总结"],
                ["successfulPractices", "成功实践"],
                ["shortcomings", "不足"],
                ["improvements", "改进措施"],
                ["knowledgeDisposition", "知识处置"],
                ["ipDeclaration", "知识产权与脱敏声明"]
              ] as const
            ).map(([field, label]) => (
              <label key={field}>
                {label}
                <textarea
                  required
                  value={createDraft[field]}
                  onChange={(event) =>
                    setCreateDraft((draft) => ({ ...draft, [field]: event.target.value }))
                  }
                />
              </label>
            ))}
            <label>
              参与成员 ID（逗号分隔，可选）
              <input
                value={createDraft.participantMembershipIds}
                onChange={(event) =>
                  setCreateDraft((draft) => ({
                    ...draft,
                    participantMembershipIds: event.target.value
                  }))
                }
              />
            </label>
            <label>
              问题历史 ID（逗号分隔，可选）
              <input
                value={createDraft.issueHistoryIds}
                onChange={(event) =>
                  setCreateDraft((draft) => ({ ...draft, issueHistoryIds: event.target.value }))
                }
              />
            </label>
            <button type="submit">创建复盘</button>
          </form>
        ) : null}
        {can("SUBMIT") && state.currentVersion && state.aggregateVersion !== null ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                `retrospective-submit-${state.currentVersion!.id}`,
                `/api/projects/${encodeURIComponent(projectId)}/retrospectives/${encodeURIComponent(state.currentVersion!.id)}/submit`,
                { expectedAggregateVersion: state.aggregateVersion }
              );
            }}
          >
            <h2>提交复盘</h2>
            <button type="submit">提交复盘</button>
          </form>
        ) : null}
        {can("REVIEW") && state.currentVersion && state.aggregateVersion !== null ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                `retrospective-review-${state.currentVersion!.id}`,
                `/api/projects/${encodeURIComponent(projectId)}/retrospectives/${encodeURIComponent(state.currentVersion!.id)}/reviews`,
                {
                  expectedAggregateVersion: state.aggregateVersion,
                  decision: reviewDecision,
                  reason: reviewReason
                }
              );
            }}
          >
            <h2>审核复盘</h2>
            <label>
              审核决定
              <select
                value={reviewDecision}
                onChange={(event) => setReviewDecision(event.target.value as typeof reviewDecision)}
              >
                <option value="APPROVED">批准</option>
                <option value="REJECTED">驳回</option>
              </select>
            </label>
            <label>
              审核意见
              <textarea
                required
                value={reviewReason}
                onChange={(event) => setReviewReason(event.target.value)}
              />
            </label>
            <button type="submit">审核复盘</button>
          </form>
        ) : null}
        {can("GENERATE_ARCHIVE_B") && state.projectVersion > 0 ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                `archive-b-${state.projectVersion}`,
                `/api/projects/${encodeURIComponent(projectId)}/archive/generate`,
                { version: state.projectVersion }
              );
            }}
          >
            <h2>生成归档 B</h2>
            <button type="submit">生成归档 B</button>
          </form>
        ) : null}
        {(can("RUN_G9") || state.g9Workflow?.canApprove) && state.g9Workflow ? (
          <section aria-label="G9 真实步骤">
            <h2>G9 步骤</h2>
            {state.g9Workflow.canRunChecks ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(
                    `g9-checks-${state.g9Workflow!.instanceId}`,
                    `/api/projects/${encodeURIComponent(projectId)}/gate-instances/${encodeURIComponent(state.g9Workflow!.instanceId)}/checks`,
                    { version: state.g9Workflow!.instanceVersion, reason: gateReason }
                  );
                }}
              >
                <label>
                  G9 检查原因
                  <textarea
                    required
                    value={gateReason}
                    onChange={(event) => setGateReason(event.target.value)}
                  />
                </label>
                <button type="submit">运行 G9 检查</button>
              </form>
            ) : null}
            {state.g9Workflow.canSubmit ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(
                    `g9-submit-${state.g9Workflow!.instanceId}`,
                    `/api/projects/${encodeURIComponent(projectId)}/gate-instances/${encodeURIComponent(state.g9Workflow!.instanceId)}/submissions`,
                    { version: state.g9Workflow!.instanceVersion, reason: gateReason }
                  );
                }}
              >
                <label>
                  G9 提交理由
                  <textarea
                    required
                    value={gateReason}
                    onChange={(event) => setGateReason(event.target.value)}
                  />
                </label>
                <button type="submit">提交 G9</button>
              </form>
            ) : null}
            {state.g9Workflow.canApprove && state.g9Workflow.submission ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(
                    `g9-approve-${state.g9Workflow!.submission!.id}`,
                    `/api/projects/${encodeURIComponent(projectId)}/gate-submissions/${encodeURIComponent(state.g9Workflow!.submission!.id)}/approve`,
                    { version: state.g9Workflow!.submission!.version, reason: gateReason }
                  );
                }}
              >
                <label>
                  G9 审批理由
                  <textarea
                    required
                    value={gateReason}
                    onChange={(event) => setGateReason(event.target.value)}
                  />
                </label>
                <button type="submit">批准 G9</button>
              </form>
            ) : null}
          </section>
        ) : null}
        {can("CLOSE_PROJECT") && state.g9Approval && state.archiveB && state.projectVersion > 0 ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const operationId = closeOperationId || commandKey("project-close");
              setCloseOperationId(operationId);
              void run(
                `project-close-${operationId}`,
                `/api/projects/${encodeURIComponent(projectId)}/close`,
                {
                  archiveVersionId: state.archiveB!.id,
                  g9SubmissionId: state.g9Approval!.submissionId,
                  expectedProjectVersion: state.projectVersion,
                  operationId
                }
              );
            }}
          >
            <h2>关闭项目</h2>
            <button type="submit">关闭项目</button>
          </form>
        ) : null}
      </section>
      {message ? <p role="alert">{message}</p> : null}
      {state.status === "STALE" || message?.includes("CONFLICT") ? (
        <div className="governance-conflict-actions">
          <button type="button" onClick={() => void reload()}>
            刷新服务器状态
          </button>
          <p>输入与幂等键已保留；请核对服务器状态后重新提交。</p>
        </div>
      ) : null}
    </main>
  );
}
