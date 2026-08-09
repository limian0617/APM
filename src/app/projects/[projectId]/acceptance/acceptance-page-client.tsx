"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  buildAcceptancePageState,
  isAcceptancePageDataState,
  resolveAcceptanceFixture,
  toAcceptanceFetchResult,
  type AcceptanceFetchResult,
  type AcceptancePageDataState,
  type AcceptanceNonDataState,
  type AcceptancePageState
} from "@/modules/acceptance/contracts/acceptance-page-state";

type AcceptancePageClientProps = Readonly<{
  projectId: string;
  initialState: AcceptancePageState | null;
}>;

type AcceptancePageContentProps = Readonly<{
  projectId: string;
  state: AcceptancePageState;
  selectedBatchId: string | null;
  fixture?: string | null;
  onRetry: () => void;
  onCommand?: (path: string, body: Record<string, unknown>) => Promise<void>;
  commandError?: string | null;
}>;

export function acceptanceCommandsForBatch(input: {
  status: unknown;
  allowedActions: readonly unknown[];
}): readonly string[] {
  const actions = new Set(
    input.allowedActions.filter((value): value is string => typeof value === "string")
  );
  if (input.status === "DRAFT") return actions.has("START_BATCH") ? ["START_BATCH"] : [];
  if (input.status === "IN_PROGRESS") {
    return ["RECORD_RESULT", "REVISE_RESULT", "LOCK_BATCH"].filter((action) => actions.has(action));
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown, fallback = "未提供") {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value : fallback;
}

function dateTime(value: string | null) {
  return value ? value.slice(0, 16).replace("T", " ") : "尚无时间";
}

export function acceptanceCommandErrorMessage(
  status: number,
  payload: { error?: { code?: string; message?: string } } | null
) {
  const code = payload?.error?.code;
  if (status === 409 && code === "ACCEPTANCE_FAILURE_ISSUE_REQUIRED") {
    return "锁定前必须为所有 FAIL 结果关联统一问题。";
  }
  if (status === 409 && code === "ISSUE_RELATION_EXISTS") {
    return "该问题与失败结果已经关联，可刷新查看最新关系。";
  }
  if (status === 409) return "验收数据已被其他成员更新，请刷新后重试。";
  return payload?.error?.message ?? "验收命令未完成。";
}

function percentage(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : "不可计算";
}

function issueStatusLabel(value: unknown) {
  if (value === "CLOSED") return "已关闭，待复测";
  if (value === "VERIFICATION_PENDING") return "验证中，待复测";
  if (value === "PENDING_ACCEPTANCE") return "待确认";
  return "未关闭，待复测";
}

function issueHref(projectId: string, issueId: unknown) {
  if (typeof issueId !== "string" || !issueId.trim()) return null;
  return `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}`;
}

function belongsToProject(batch: Record<string, unknown>, projectId: string) {
  return batch.projectId === projectId;
}

function batchHref(projectId: string, batch: Record<string, unknown>, fixture?: string | null) {
  if (!belongsToProject(batch, projectId) || typeof batch.id !== "string" || !batch.id.trim())
    return null;
  const params = new URLSearchParams({ batch: batch.id });
  if (resolveAcceptanceFixture(fixture, process.env.NODE_ENV)) params.set("fixture", fixture!);
  return `/projects/${encodeURIComponent(projectId)}/acceptance?${params.toString()}`;
}

function AcceptanceStatePanel({
  state,
  onRetry
}: {
  state: AcceptanceNonDataState;
  onRetry: () => void;
}) {
  const label: Record<typeof state.status, string> = {
    loading: "验收数据加载中",
    empty: "暂无 FAT/SAT 验收模板或批次",
    denied: "无权查看项目 FAT/SAT 验收",
    error: "验收数据暂不可用"
  };
  return (
    <main className="acceptance-page acceptance-state-page" aria-busy={state.status === "loading"}>
      <section className="acceptance-state-panel" aria-labelledby="acceptance-state-title">
        <p className="acceptance-eyebrow">PROJECT ACCEPTANCE</p>
        <h1 id="acceptance-state-title">{label[state.status]}</h1>
        <p>
          {state.status === "denied"
            ? "当前身份没有此项目的验收读取权限。"
            : state.status === "empty"
              ? "可先由有权限的成员发布不可变模板版本并创建项目验收批次。"
              : "请在数据恢复后重新加载。"}
        </p>
        {state.status === "error" && state.retryable ? (
          <button className="acceptance-command" type="button" onClick={onRetry}>
            重新加载
          </button>
        ) : null}
      </section>
    </main>
  );
}

function TemplateList({ state }: { state: AcceptancePageDataState }) {
  return (
    <section className="acceptance-list-section" aria-label="验收模板版本">
      <div className="acceptance-section-heading">
        <h2>验收模板版本</h2>
        <span>{state.templates.length} 个</span>
      </div>
      {state.templates.length === 0 ? (
        <p className="acceptance-empty-inline">暂无已发布模板。</p>
      ) : (
        <ul className="acceptance-list">
          {state.templates.map((template, index) => {
            const templateInfo = isRecord(template.template) ? template.template : {};
            const itemCount = list(template.items).length;
            return (
              <li key={text(template.id, `template-${index}`)}>
                <strong>{text(templateInfo.name, text(templateInfo.code, "验收模板"))}</strong>
                <span>
                  {text(template.acceptanceType)} · {itemCount} 项测试项 · 版本{" "}
                  {text(template.version)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function BatchList({
  projectId,
  state,
  selectedBatchId,
  fixture
}: {
  projectId: string;
  state: AcceptancePageDataState;
  selectedBatchId: string | null;
  fixture?: string | null;
}) {
  return (
    <section className="acceptance-list-section" aria-label="验收批次">
      <div className="acceptance-section-heading">
        <h2>验收批次</h2>
        <span>{state.batches.length} 个</span>
      </div>
      {state.batches.length === 0 ? (
        <p className="acceptance-empty-inline">暂无项目验收批次。</p>
      ) : (
        <ul className="acceptance-list">
          {state.batches.map((batch, index) => {
            const href = batchHref(projectId, batch, fixture);
            const selected = batch.id === selectedBatchId;
            const contents = (
              <>
                <strong>
                  {text(batch.acceptanceType)} · {text(batch.status)}
                </strong>
                <span>
                  {text(batch.scopeType)} / {text(batch.scopeId)}
                </span>
              </>
            );
            return (
              <li key={text(batch.id, `batch-${index}`)}>
                {href ? (
                  <a href={href} aria-current={selected ? "page" : undefined}>
                    {contents}
                  </a>
                ) : (
                  contents
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ResultRevisionForm({
  projectId,
  batchId,
  itemId,
  version,
  frozenUnit,
  current,
  requireCorrection,
  onCommand
}: {
  projectId: string;
  batchId: string;
  itemId: string;
  version: number;
  frozenUnit: string | null;
  current: Record<string, unknown> | null;
  requireCorrection: boolean;
  onCommand: (path: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const [decision, setDecision] = useState(text(current?.decision, "NA"));
  const [measuredValue, setMeasuredValue] = useState(text(current?.measuredValue, ""));
  const [note, setNote] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [evidenceFileIds, setEvidenceFileIds] = useState("");
  return (
    <form
      className="acceptance-result-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onCommand(
          `/api/projects/${encodeURIComponent(projectId)}/acceptance/batches/${encodeURIComponent(batchId)}/results`,
          {
            version,
            itemId,
            decision,
            measuredValue: measuredValue || null,
            measuredUnit: frozenUnit,
            note: note || null,
            correctionReason: correctionReason || null,
            evidenceFileIds: evidenceFileIds
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
          }
        );
      }}
    >
      <label>
        判定
        <select value={decision} onChange={(event) => setDecision(event.target.value)}>
          <option value="PASS">PASS</option>
          <option value="FAIL">FAIL</option>
          <option value="NA">NA</option>
        </select>
      </label>
      <label>
        实测值
        <input value={measuredValue} onChange={(event) => setMeasuredValue(event.target.value)} />
      </label>
      <span className="acceptance-frozen-unit">单位：{frozenUnit ?? "无"}</span>
      <label>
        备注
        <input value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <label>
        证据文件ID（逗号分隔）
        <input
          value={evidenceFileIds}
          onChange={(event) => setEvidenceFileIds(event.target.value)}
          placeholder="已扫描且可用的文件"
        />
      </label>
      {requireCorrection ? (
        <label>
          修订原因（必填）
          <input
            required
            value={correctionReason}
            onChange={(event) => setCorrectionReason(event.target.value)}
          />
        </label>
      ) : null}
      <button className="acceptance-command" type="submit">
        {requireCorrection ? "追加修订" : "录入结果"}
      </button>
    </form>
  );
}

function FailureIssueActions({
  projectId,
  batchId,
  revisionId,
  issueLinks,
  canCreate,
  canLink,
  onCommand
}: {
  projectId: string;
  batchId: string;
  revisionId: string;
  issueLinks: readonly Record<string, unknown>[];
  canCreate: boolean;
  canLink: boolean;
  onCommand: (path: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [title, setTitle] = useState("");
  const [confirmedText, setConfirmedText] = useState("");
  const [category, setCategory] = useState("FUNCTION");
  const [severity, setSeverity] = useState("MEDIUM");
  const [issueId, setIssueId] = useState("");
  const [issueVersion, setIssueVersion] = useState("1");
  const [reason, setReason] = useState("");
  const createPath = `/api/projects/${encodeURIComponent(projectId)}/acceptance/batches/${encodeURIComponent(batchId)}/results/${encodeURIComponent(revisionId)}/issues`;
  const linkPath = `${createPath}/link`;
  return (
    <div className="acceptance-failure-issues" aria-label="失败结果关联问题">
      <div className="acceptance-issue-list">
        {issueLinks.length === 0 ? (
          <span className="acceptance-issue-unlinked">未关联统一问题</span>
        ) : (
          issueLinks.map((link, index) => {
            const issue = isRecord(link.issue) ? link.issue : {};
            const href = issueHref(projectId, issue.id);
            return (
              <div
                className="acceptance-issue-summary"
                key={text(link.relationId, `issue-link-${index}`)}
              >
                {href ? <a href={href}>#{text(issue.id)}</a> : <strong>问题</strong>}
                <span>{text(issue.title)}</span>
                <span>
                  {text(issue.category)} · {text(issue.severity)}
                </span>
                <span>{issueStatusLabel(issue.status)}</span>
                <span>Owner：{text(issue.ownerMembershipId)}</span>
                <span>截止：{text(issue.dueDate)}</span>
              </div>
            );
          })
        )}
      </div>
      <div className="acceptance-issue-actions">
        {canCreate ? (
          <button
            className="acceptance-command"
            type="button"
            onClick={() => setShowCreate((value) => !value)}
          >
            创建问题
          </button>
        ) : null}
        {canLink ? (
          <button
            className="acceptance-command"
            type="button"
            onClick={() => setShowLink((value) => !value)}
          >
            关联已有问题
          </button>
        ) : null}
      </div>
      {showCreate && canCreate ? (
        <form
          className="acceptance-issue-form"
          aria-label="从失败结果创建问题"
          onSubmit={(event) => {
            event.preventDefault();
            void onCommand(createPath, { title, confirmedText, category, severity });
            setShowCreate(false);
          }}
        >
          <label>
            标题
            <input required value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            问题描述
            <textarea
              required
              value={confirmedText}
              onChange={(event) => setConfirmedText(event.target.value)}
            />
          </label>
          <label>
            分类
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="SAFETY">SAFETY</option>
              <option value="FUNCTION">FUNCTION</option>
              <option value="PERFORMANCE">PERFORMANCE</option>
              <option value="APPEARANCE">APPEARANCE</option>
              <option value="DELIVERY_COMPLETENESS">DELIVERY_COMPLETENESS</option>
            </select>
          </label>
          <label>
            严重度
            <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
              <option value="LOW">LOW</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="HIGH">HIGH</option>
              <option value="CRITICAL">CRITICAL</option>
            </select>
          </label>
          <button className="acceptance-command" type="submit">
            确认创建
          </button>
        </form>
      ) : null}
      {showLink && canLink ? (
        <form
          className="acceptance-issue-form"
          aria-label="关联已有问题"
          onSubmit={(event) => {
            event.preventDefault();
            void onCommand(linkPath, { issueId, issueVersion: Number(issueVersion), reason });
            setShowLink(false);
          }}
        >
          <label>
            问题ID
            <input required value={issueId} onChange={(event) => setIssueId(event.target.value)} />
          </label>
          <label>
            问题版本
            <input
              required
              type="number"
              min="1"
              value={issueVersion}
              onChange={(event) => setIssueVersion(event.target.value)}
            />
          </label>
          <label>
            关联原因
            <input required value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <button className="acceptance-command" type="submit">
            确认关联
          </button>
        </form>
      ) : null}
    </div>
  );
}

function BatchDetail({
  projectId,
  state,
  onCommand
}: {
  projectId: string;
  state: AcceptancePageDataState;
  onCommand: (path: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const detail = state.batchDetail;
  const batch = detail && isRecord(detail.batch) ? detail.batch : null;
  if (!batch)
    return (
      <section className="acceptance-detail" aria-label="验收测试项与结果">
        <p className="acceptance-empty-inline">选择验收批次后查看冻结测试项和追加式结果历史。</p>
      </section>
    );
  const templateVersion = isRecord(batch.templateVersion) ? batch.templateVersion : {};
  const itemDefinitions = list(templateVersion.items);
  const results = list(batch.results);
  const resultsByItem = new Map(results.map((result) => [result.itemId, result]));
  const summary = detail && isRecord(detail.summary) ? detail.summary : {};
  const allowedActions = Array.isArray(detail?.allowedActions)
    ? detail.allowedActions.filter((action): action is string => typeof action === "string")
    : [];
  const commands = acceptanceCommandsForBatch({ status: batch.status, allowedActions });
  const canCreateFailureIssue = allowedActions.includes("CREATE_FAILURE_ISSUE");
  const canLinkFailureIssue = allowedActions.includes("LINK_FAILURE_ISSUE");
  const unlinkedFailureCount =
    typeof summary.unlinkedFailureCount === "number" ? summary.unlinkedFailureCount : 0;
  const batchId = typeof batch.id === "string" ? batch.id : null;
  const version = typeof batch.version === "number" ? batch.version : null;
  return (
    <section className="acceptance-detail" aria-label="验收测试项与结果">
      <div className="acceptance-section-heading">
        <h2>测试项与结果</h2>
        <span>
          通过率 {percentage(summary.passRate)} · {text(summary.outcome)}
        </span>
      </div>
      {unlinkedFailureCount > 0 ? (
        <p className="acceptance-command-error" role="status">
          存在 {unlinkedFailureCount} 个未关联统一问题的 FAIL 项；锁定前必须关联问题。
        </p>
      ) : null}
      {batchId && version !== null && commands.includes("START_BATCH") ? (
        <button
          className="acceptance-command"
          type="button"
          onClick={() =>
            void onCommand(
              `/api/projects/${encodeURIComponent(projectId)}/acceptance/batches/${encodeURIComponent(batchId)}/start`,
              { version }
            )
          }
        >
          开始批次
        </button>
      ) : null}
      {batchId && version !== null && commands.includes("LOCK_BATCH") ? (
        <button
          className="acceptance-command"
          type="button"
          onClick={() =>
            void onCommand(
              `/api/projects/${encodeURIComponent(projectId)}/acceptance/batches/${encodeURIComponent(batchId)}/lock`,
              { version }
            )
          }
        >
          确认并锁定批次
        </button>
      ) : null}
      {itemDefinitions.length === 0 ? (
        <p className="acceptance-empty-inline">该冻结模板没有可显示的测试项。</p>
      ) : (
        <div className="acceptance-table-wrap">
          <table>
            <thead>
              <tr>
                <th>测试项</th>
                <th>要求</th>
                <th>当前结果</th>
                <th>实测值</th>
              </tr>
            </thead>
            <tbody>
              {itemDefinitions.map((item, index) => {
                const result = resultsByItem.get(item.id);
                const revisions = result ? list(result.revisions) : [];
                const current = revisions[0] ?? null;
                const itemId = typeof item.id === "string" ? item.id : null;
                const issueLinks =
                  current && Array.isArray(current.issueLinks)
                    ? current.issueLinks.filter(isRecord)
                    : [];
                return (
                  <tr key={text(item.id, `item-${index}`)}>
                    <th scope="row">
                      <strong>{text(item.code)}</strong>
                      <small>{text(item.name)}</small>
                    </th>
                    <td>
                      {item.required === true ? "必测" : "可选"}
                      {item.evidenceRequired === true ? " · 需证据" : ""}
                    </td>
                    <td>{current ? text(current.decision) : "未录入"}</td>
                    <td>
                      {current
                        ? `${text(current.measuredValue, "未提供")}${current.measuredUnit ? ` ${text(current.measuredUnit)}` : ""}`
                        : "—"}
                      {current?.decision === "FAIL" && typeof current.id === "string" && batchId ? (
                        <FailureIssueActions
                          projectId={projectId}
                          batchId={batchId}
                          revisionId={current.id}
                          issueLinks={issueLinks}
                          canCreate={canCreateFailureIssue}
                          canLink={canLinkFailureIssue}
                          onCommand={onCommand}
                        />
                      ) : null}
                      {batchId &&
                      version !== null &&
                      itemId &&
                      (commands.includes("RECORD_RESULT") || commands.includes("REVISE_RESULT")) ? (
                        <ResultRevisionForm
                          projectId={projectId}
                          batchId={batchId}
                          itemId={itemId}
                          version={version}
                          frozenUnit={typeof item.unit === "string" ? item.unit : null}
                          current={current}
                          requireCorrection={Boolean(current)}
                          onCommand={onCommand}
                        />
                      ) : null}
                    </td>
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

function BatchCreationForm({
  projectId,
  state,
  onCommand
}: {
  projectId: string;
  state: AcceptancePageDataState;
  onCommand: (path: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const templates = state.templates;
  const firstTemplate = templates[0];
  const firstType =
    firstTemplate && typeof firstTemplate.acceptanceType === "string"
      ? firstTemplate.acceptanceType
      : "FAT";
  const [acceptanceType, setAcceptanceType] = useState(firstType);
  const [scopeType, setScopeType] = useState("PROJECT");
  const [scopeId, setScopeId] = useState(projectId);
  const [templateVersionId, setTemplateVersionId] = useState(
    firstTemplate && typeof firstTemplate.id === "string" ? firstTemplate.id : ""
  );
  const availableTemplates = templates.filter(
    (template) => template.acceptanceType === acceptanceType
  );
  if (!state.batchAllowedActions?.includes("CREATE_BATCH")) return null;
  return (
    <form
      className="acceptance-create-form"
      aria-label="创建验收批次"
      onSubmit={(event) => {
        event.preventDefault();
        void onCommand(`/api/projects/${encodeURIComponent(projectId)}/acceptance/batches`, {
          acceptanceType,
          scopeType,
          scopeId,
          templateVersionId,
          version: 0
        });
      }}
    >
      <label>
        验收类型
        <select value={acceptanceType} onChange={(event) => setAcceptanceType(event.target.value)}>
          <option value="FAT">FAT</option>
          <option value="SAT">SAT</option>
        </select>
      </label>
      <label>
        范围
        <select value={scopeType} onChange={(event) => setScopeType(event.target.value)}>
          <option value="PROJECT">项目</option>
          <option value="DELIVERY_UNIT">交付单元</option>
          <option value="MACHINE">单机</option>
        </select>
      </label>
      <label>
        范围ID
        <input value={scopeId} onChange={(event) => setScopeId(event.target.value)} required />
      </label>
      <label>
        已发布模板
        <select
          value={templateVersionId}
          onChange={(event) => setTemplateVersionId(event.target.value)}
          required
        >
          <option value="">请选择</option>
          {availableTemplates.map((template) => (
            <option key={text(template.id)} value={text(template.id)}>
              {text(
                template.template && isRecord(template.template)
                  ? template.template.name
                  : template.code
              )}{" "}
              · v{text(template.version)}
            </option>
          ))}
        </select>
      </label>
      <button className="acceptance-command" type="submit" disabled={!templateVersionId}>
        创建批次
      </button>
    </form>
  );
}

export function AcceptancePageContent({
  projectId,
  state,
  selectedBatchId,
  fixture,
  onRetry,
  onCommand,
  commandError
}: AcceptancePageContentProps) {
  const executeCommand = onCommand ?? (async () => undefined);
  if (!isAcceptancePageDataState(state))
    return <AcceptanceStatePanel state={state} onRetry={onRetry} />;
  return (
    <main className="acceptance-page" aria-label="项目 FAT/SAT 验收">
      <header className="acceptance-header">
        <div>
          <p className="acceptance-eyebrow">PROJECT ACCEPTANCE</p>
          <h1>FAT/SAT 验收</h1>
          <p>
            {state.status === "stale"
              ? "数据已过期，请确认来源后使用。"
              : "冻结模板、批次与结果修订历史"}
          </p>
        </div>
        <dl className="acceptance-source-timestamps">
          <div>
            <dt>模板读取</dt>
            <dd>{dateTime(state.timestamps.templates)}</dd>
          </div>
          <div>
            <dt>批次读取</dt>
            <dd>{dateTime(state.timestamps.batches)}</dd>
          </div>
          <div>
            <dt>批次详情</dt>
            <dd>{dateTime(state.timestamps.batchDetail)}</dd>
          </div>
        </dl>
      </header>
      {commandError ? (
        <p className="acceptance-command-error" role="alert">
          {commandError}
        </p>
      ) : null}
      <div className="acceptance-context-band">
        <div>
          <span>模板版本</span>
          <strong>{state.templates.length}</strong>
        </div>
        <div>
          <span>验收批次</span>
          <strong>{state.batches.length}</strong>
        </div>
        <div>
          <span>数据状态</span>
          <strong>{state.status === "stale" ? "已过期" : "当前可用"}</strong>
        </div>
      </div>
      <BatchCreationForm projectId={projectId} state={state} onCommand={executeCommand} />
      <div className="acceptance-overview-grid">
        <TemplateList state={state} />
        <BatchList
          projectId={projectId}
          state={state}
          selectedBatchId={selectedBatchId}
          fixture={fixture}
        />
      </div>
      <BatchDetail projectId={projectId} state={state} onCommand={executeCommand} />
    </main>
  );
}

async function fetchAcceptanceSource(path: string): Promise<AcceptanceFetchResult> {
  try {
    const response = await fetch(path, { cache: "no-store" });
    const body = await response.json().catch(() => undefined);
    if (response.ok && body === undefined) return toAcceptanceFetchResult({ status: 502 });
    return toAcceptanceFetchResult({
      status: response.status,
      body,
      fetchedAt: new Date().toISOString()
    });
  } catch {
    return toAcceptanceFetchResult({ status: 0 });
  }
}

function selectedExistingBatchId(
  projectId: string,
  source: AcceptanceFetchResult,
  requested: string | null
) {
  if (source.status < 200 || source.status >= 300 || !isRecord(source.body)) return null;
  const candidates = list(source.body.batches).filter((batch) =>
    belongsToProject(batch, projectId)
  );
  const selected = candidates.find((batch) => batch.id === requested) ?? candidates[0];
  return typeof selected?.id === "string" ? selected.id : null;
}

export async function loadAcceptancePageState(
  projectId: string,
  requestedBatchId: string | null
): Promise<AcceptancePageState> {
  const root = `/api/projects/${encodeURIComponent(projectId)}/acceptance`;
  const [templates, batches] = await Promise.all([
    fetchAcceptanceSource(`${root}/templates?limit=100`),
    fetchAcceptanceSource(`${root}/batches?limit=100`)
  ]);
  const batchId = selectedExistingBatchId(projectId, batches, requestedBatchId);
  const batchDetail = batchId
    ? await fetchAcceptanceSource(`${root}/batches/${encodeURIComponent(batchId)}`)
    : undefined;
  return buildAcceptancePageState({ projectId, templates, batches, batchDetail });
}

export function AcceptancePageClient({ projectId, initialState }: AcceptancePageClientProps) {
  const searchParams = useSearchParams();
  const requestedBatchId = searchParams.get("batch");
  const fixture = resolveAcceptanceFixture(searchParams.get("fixture"), process.env.NODE_ENV);
  const [state, setState] = useState<AcceptancePageState>(
    initialState ?? { projectId, status: "loading" }
  );
  const [commandError, setCommandError] = useState<string | null>(null);
  const reload = useCallback(
    async () => setState(await loadAcceptancePageState(projectId, requestedBatchId)),
    [projectId, requestedBatchId]
  );
  useEffect(() => {
    if (initialState) return;
    let cancelled = false;
    void loadAcceptancePageState(projectId, requestedBatchId).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [initialState, projectId, requestedBatchId]);
  const selectedBatchId = useMemo(
    () =>
      state.status === "ready" || state.status === "stale"
        ? selectedExistingBatchId(
            projectId,
            {
              kind: "response",
              status: 200,
              body: { batches: state.batches },
              fetchedAt: null,
              stale: false,
              retryable: false
            },
            requestedBatchId
          )
        : null,
    [projectId, requestedBatchId, state]
  );
  const runCommand = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      setCommandError(null);
      try {
        const response = await fetch(path, {
          method: "POST",
          cache: "no-store",
          headers: {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID()
          },
          body: JSON.stringify(body)
        });
        const payload = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        if (!response.ok) {
          setCommandError(acceptanceCommandErrorMessage(response.status, payload));
          return;
        }
        await reload();
      } catch {
        setCommandError("验收命令暂时无法连接服务，请稍后重试。");
      }
    },
    [reload]
  );
  return (
    <AcceptancePageContent
      projectId={projectId}
      state={state}
      selectedBatchId={selectedBatchId}
      fixture={fixture}
      onRetry={() => void reload()}
      onCommand={runCommand}
      commandError={commandError}
    />
  );
}
