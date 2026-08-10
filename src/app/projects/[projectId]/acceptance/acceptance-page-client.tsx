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
import {
  buildAcceptanceReportPageState,
  resolveAcceptanceReportFixture,
  type AcceptanceReportFetchResult,
  type AcceptanceReportPageState
} from "@/modules/acceptance/contracts/acceptance-report-page-state";
import {
  buildSatOfflineDraftQueueState,
  type SatOfflineDraftQueueState
} from "@/modules/acceptance/contracts/sat-offline-draft-page-state";
import {
  createOfflineSatDraftRecord,
  listOfflineSatDrafts,
  markOfflineSatDraftForSync,
  markOfflineSatDraftSyncFailed,
  markOfflineSatDraftSyncResult,
  offlineDraftDisplayState,
  saveOfflineSatDraft,
  type OfflineSatDraftRecord
} from "@/modules/acceptance/infrastructure/sat-offline-draft-store";

type AcceptancePageClientProps = Readonly<{
  projectId: string;
  initialState: AcceptancePageState | null;
  initialReportState?: AcceptanceReportPageState | null;
}>;

type AcceptancePageContentProps = Readonly<{
  projectId: string;
  state: AcceptancePageState;
  selectedBatchId: string | null;
  fixture?: string | null;
  onRetry: () => void;
  onCommand?: (path: string, body: Record<string, unknown>) => Promise<void>;
  commandError?: string | null;
  reportState?: AcceptanceReportPageState;
  onReportCommand?: (path: string, body: Record<string, unknown>) => Promise<void>;
  reportCommandError?: string | null;
  offlineDraftQueueState?: SatOfflineDraftQueueState;
  localOfflineDrafts?: readonly OfflineSatDraftRecord[];
  onSaveOfflineDraft?: (
    draft: Omit<
      OfflineSatDraftRecord,
      "localStatus" | "serverStatus" | "submissionId" | "lastError" | "updatedAt"
    >
  ) => Promise<void>;
  onSyncOfflineDraft?: (draft: OfflineSatDraftRecord) => Promise<void>;
  onReviewOfflineDraft?: (submissionId: string, body: Record<string, unknown>) => Promise<void>;
  offlineDraftError?: string | null;
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

type ConfirmationEvidenceFile = Blob & { name: string; type: string; size: number };
type BrowserFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function clientIdempotencyKey(): string {
  return crypto.randomUUID();
}

async function readUploadResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => null);
  if (response.ok && isRecord(body)) return body;
  const error = isRecord(body) && isRecord(body.error) ? body.error.message : null;
  throw new Error(typeof error === "string" ? error : "确认凭证上传未完成。");
}

/**
 * Confirmation evidence always enters the existing private file pipeline as
 * RESTRICTED. A confirmation cannot use the returned id until the server-side
 * scanner promotes the file to AVAILABLE/CONTROLLED.
 */
export async function uploadConfirmationEvidenceFile(input: {
  projectId: string;
  file: ConfirmationEvidenceFile;
  fetchImpl?: BrowserFetch;
}): Promise<{ fileId: string; status: string }> {
  const projectId = input.projectId.trim();
  const originalName = input.file.name.trim();
  const mimeType = input.file.type.trim().toLowerCase() || "application/octet-stream";
  if (!projectId || !originalName || input.file.size <= 0) {
    throw new Error("请选择一个有效的确认凭证文件。");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = `/api/projects/${encodeURIComponent(projectId)}/files/uploads`;
  const started = await readUploadResponse(
    await fetchImpl(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": clientIdempotencyKey()
      },
      body: JSON.stringify({
        originalName,
        mimeType,
        size: input.file.size,
        sensitivity: "RESTRICTED"
      })
    })
  );
  const upload = isRecord(started.upload) ? started.upload : null;
  const startedFile = isRecord(started.file) ? started.file : null;
  const sessionId = typeof upload?.sessionId === "string" ? upload.sessionId : null;
  const expectedParts = typeof upload?.expectedParts === "number" ? upload.expectedParts : null;
  const partSize = typeof upload?.partSize === "number" ? upload.partSize : null;
  const fileId = typeof startedFile?.id === "string" ? startedFile.id : null;
  if (!sessionId || !fileId || !expectedParts || !partSize) {
    throw new Error("确认凭证上传会话响应无效。");
  }
  const parts: Array<{ partNumber: number; etag: string; size: number }> = [];
  for (let partNumber = 1; partNumber <= expectedParts; partNumber += 1) {
    const part = await readUploadResponse(
      await fetchImpl(`${base}/${encodeURIComponent(sessionId)}/parts/${partNumber}`, {
        method: "POST"
      })
    );
    const uploadUrl = typeof part.uploadUrl === "string" ? part.uploadUrl : null;
    const expectedSize = typeof part.expectedSize === "number" ? part.expectedSize : null;
    if (!uploadUrl || !expectedSize || expectedSize <= 0) {
      throw new Error("确认凭证分片上传地址无效。");
    }
    const start = (partNumber - 1) * partSize;
    const uploaded = await fetchImpl(uploadUrl, {
      method: "PUT",
      headers: { "content-type": mimeType },
      body: input.file.slice(start, start + expectedSize)
    });
    const etag = uploaded.headers.get("etag");
    if (!uploaded.ok || !etag) throw new Error("确认凭证分片上传失败。");
    parts.push({ partNumber, etag, size: expectedSize });
  }
  const completed = await readUploadResponse(
    await fetchImpl(`${base}/${encodeURIComponent(sessionId)}/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": clientIdempotencyKey()
      },
      body: JSON.stringify({ mimeType, size: input.file.size, parts })
    })
  );
  const completedFile = isRecord(completed.file) ? completed.file : null;
  const completedFileId = typeof completedFile?.id === "string" ? completedFile.id : fileId;
  const status = typeof completedFile?.status === "string" ? completedFile.status : "PENDING_SCAN";
  return { fileId: completedFileId, status };
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

export function acceptanceReportDownloadHref(projectId: string, reportId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/acceptance/reports/${encodeURIComponent(reportId)}/download`;
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
  onCommand,
  isSat,
  onSaveOfflineDraft
}: {
  projectId: string;
  batchId: string;
  itemId: string;
  version: number;
  frozenUnit: string | null;
  current: Record<string, unknown> | null;
  requireCorrection: boolean;
  onCommand: (path: string, body: Record<string, unknown>) => Promise<void>;
  isSat: boolean;
  onSaveOfflineDraft?: AcceptancePageContentProps["onSaveOfflineDraft"];
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
      {isSat && onSaveOfflineDraft ? (
        <button
          className="acceptance-command"
          type="button"
          onClick={() =>
            void onSaveOfflineDraft({
              clientDraftId: crypto.randomUUID(),
              projectId,
              batchId,
              itemId,
              baselineBatchVersion: version,
              baselineResultRevisionId: typeof current?.id === "string" ? current.id : null,
              decision: decision as "PASS" | "FAIL" | "NA",
              measuredValue: measuredValue || null,
              measuredUnit: frozenUnit,
              note: note || null,
              capturedAt: new Date().toISOString()
            })
          }
        >
          保存 SAT 离线草稿
        </button>
      ) : null}
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
  onCommand,
  onSaveOfflineDraft
}: {
  projectId: string;
  state: AcceptancePageDataState;
  onCommand: (path: string, body: Record<string, unknown>) => Promise<void>;
  onSaveOfflineDraft?: AcceptancePageContentProps["onSaveOfflineDraft"];
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
  const isSat = batch.acceptanceType === "SAT";
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
                          isSat={isSat}
                          onSaveOfflineDraft={onSaveOfflineDraft}
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

function reportStatusLabel(status: unknown) {
  if (status === "GENERATING") return "生成中";
  if (status === "FAILED") return "生成失败，可重试";
  if (status === "READY") return "已就绪";
  if (status === "PUBLISHED") return "已发布";
  if (status === "SUPERSEDED") return "已被新版本取代";
  return "状态未知";
}

function confirmationDecisionLabel(decision: unknown) {
  if (decision === "ACCEPTED") return "已确认";
  if (decision === "ACCEPTED_WITH_RESERVATIONS") return "附条件确认";
  if (decision === "REJECTED") return "已拒绝";
  return "未确认";
}

function ReportList({
  projectId,
  state,
  acceptanceState,
  selectedBatchId,
  onCommand,
  commandError
}: {
  projectId: string;
  state: AcceptanceReportPageState;
  acceptanceState: AcceptancePageState;
  selectedBatchId: string | null;
  onCommand: (path: string, body: Record<string, unknown>) => Promise<void>;
  commandError?: string | null;
}) {
  if (!("reports" in state)) {
    const message =
      state.status === "loading"
        ? "报告状态加载中…"
        : state.status === "denied"
          ? "无权查看受控验收报告。"
          : "报告状态暂不可用。";
    return (
      <section className="acceptance-reports" aria-busy={state.status === "loading"}>
        <h2>受控验收报告</h2>
        <p role={state.status === "error" ? "alert" : "status"}>{message}</p>
      </section>
    );
  }
  const detail = isAcceptancePageDataState(acceptanceState) && acceptanceState.batchDetail;
  const batch = detail && isRecord(detail.batch) ? detail.batch : null;
  const batchId = batch && typeof batch.id === "string" ? batch.id : null;
  const batchVersion = batch && typeof batch.version === "number" ? batch.version : null;
  const canGenerate =
    state.allowedActions.includes("GENERATE_REPORT") &&
    batch?.status === "LOCKED" &&
    batchId === selectedBatchId;
  return (
    <section className="acceptance-reports" aria-label="受控 FAT/SAT 验收报告">
      <div className="acceptance-section-heading">
        <h2>受控验收报告</h2>
        <span>{state.status === "stale" ? "数据已过期" : `${state.reports.length} 个版本`}</span>
      </div>
      {commandError ? (
        <p className="acceptance-command-error" role="alert">
          {commandError}
        </p>
      ) : null}
      {canGenerate && batchId && batchVersion !== null ? (
        <button
          className="acceptance-command"
          type="button"
          onClick={() =>
            void onCommand(`/api/projects/${encodeURIComponent(projectId)}/acceptance/reports`, {
              batchId,
              version: batchVersion,
              supersedesReportId: null
            })
          }
        >
          生成验收报告
        </button>
      ) : null}
      {state.reports.length === 0 ? (
        <p className="acceptance-empty-inline">暂无受控报告；只有 LOCKED 批次可以生成正式报告。</p>
      ) : (
        <ul className="acceptance-report-list">
          {state.reports.map((report, index) => {
            const reportId =
              typeof report.id === "string" && report.projectId === projectId ? report.id : null;
            const status = report.status;
            const confirmations = list(report.confirmations);
            return (
              <li key={reportId ?? `report-${index}`}>
                <div className="acceptance-report-summary">
                  <strong>
                    {text(report.reportNumber, "受控验收报告")} · v{text(report.reportVersion)}
                  </strong>
                  <span>
                    {text(report.acceptanceType)} · {text(report.scopeType)} /{" "}
                    {text(report.scopeId)} · {reportStatusLabel(status)}
                  </span>
                  <small>报告快照 SHA-256：{text(report.snapshotChecksum)}</small>
                  <small>最终 PDF 完整 SHA-256：{text(report.pdfSha256)}</small>
                  {reportId && ["READY", "PUBLISHED"].includes(String(status)) ? (
                    <a href={acceptanceReportDownloadHref(projectId, reportId)}>下载受控 PDF</a>
                  ) : null}
                </div>
                <div className="acceptance-confirmation-summary">
                  <span>
                    客户确认：
                    {confirmations.length
                      ? confirmationDecisionLabel(confirmations[0]?.decision)
                      : "未确认"}
                  </span>
                  {confirmations.map((confirmation, confirmationIndex) => (
                    <small key={text(confirmation.id, `confirmation-${confirmationIndex}`)}>
                      {confirmationDecisionLabel(confirmation.decision)} ·{" "}
                      {text(confirmation.recordedAt)} ·{" "}
                      {confirmation.status === "SUPERSEDED" ? "已取代" : "当前"}
                    </small>
                  ))}
                </div>
                {reportId &&
                state.allowedActions.includes("RECORD_CONFIRMATION") &&
                ["READY", "PUBLISHED"].includes(String(status)) ? (
                  <ConfirmationForm
                    projectId={projectId}
                    reportId={reportId}
                    report={report}
                    onCommand={onCommand}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="acceptance-signature-disclaimer">
        确认凭证仅作为项目验收证据，不等同于法律电子签名。
      </p>
    </section>
  );
}

function ConfirmationForm({
  projectId,
  reportId,
  report,
  onCommand
}: {
  projectId: string;
  reportId: string;
  report: Record<string, unknown>;
  onCommand: (path: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const [decision, setDecision] = useState("ACCEPTED");
  const [organization, setOrganization] = useState("");
  const [representative, setRepresentative] = useState("");
  const [title, setTitle] = useState("");
  const [channel, setChannel] = useState("SIGNED_DOCUMENT");
  const [confirmedAt, setConfirmedAt] = useState("");
  const [comment, setComment] = useState("");
  const [evidence, setEvidence] = useState("");
  const [evidenceUploadState, setEvidenceUploadState] = useState<string | null>(null);
  return (
    <form
      className="acceptance-confirmation-form"
      aria-label="记录客户验收确认"
      onSubmit={(event) => {
        event.preventDefault();
        void onCommand(
          `/api/projects/${encodeURIComponent(projectId)}/acceptance/reports/${encodeURIComponent(reportId)}/confirmations`,
          {
            version: typeof report.reportVersion === "number" ? report.reportVersion : 1,
            reportChecksum: report.snapshotChecksum,
            decision,
            customerOrganization: organization,
            customerRepresentative: representative,
            representativeTitle: title,
            confirmationChannel: channel,
            customerConfirmedAt: new Date(confirmedAt).toISOString(),
            comment,
            evidenceFileIds: evidence
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
          }
        );
      }}
    >
      <label>
        决定
        <select value={decision} onChange={(event) => setDecision(event.target.value)}>
          <option value="ACCEPTED">接受</option>
          <option value="ACCEPTED_WITH_RESERVATIONS">附条件接受</option>
          <option value="REJECTED">拒绝</option>
        </select>
      </label>
      <label>
        客户组织
        <input
          required
          value={organization}
          onChange={(event) => setOrganization(event.target.value)}
        />
      </label>
      <label>
        客户代表
        <input
          required
          value={representative}
          onChange={(event) => setRepresentative(event.target.value)}
        />
      </label>
      <label>
        职务
        <input required value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        渠道
        <select value={channel} onChange={(event) => setChannel(event.target.value)}>
          <option value="SIGNED_DOCUMENT">签字件</option>
          <option value="EMAIL">邮件</option>
          <option value="MEETING_MINUTES">会议纪要</option>
          <option value="OTHER">其他</option>
        </select>
      </label>
      <label>
        客户确认时间
        <input
          required
          type="datetime-local"
          value={confirmedAt}
          onChange={(event) => setConfirmedAt(event.target.value)}
        />
      </label>
      <label>
        意见
        <textarea value={comment} onChange={(event) => setComment(event.target.value)} />
      </label>
      <label>
        上传确认凭证
        <input
          type="file"
          disabled={evidenceUploadState === "正在上传确认凭证…"}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (!file) return;
            setEvidenceUploadState("正在上传确认凭证…");
            void uploadConfirmationEvidenceFile({ projectId, file })
              .then((uploaded) => {
                setEvidence((current) =>
                  [
                    ...new Set([
                      ...current.split(",").map((value) => value.trim()),
                      uploaded.fileId
                    ])
                  ]
                    .filter(Boolean)
                    .join(",")
                );
                setEvidenceUploadState(
                  uploaded.status === "PENDING_SCAN"
                    ? `已上传 ${uploaded.fileId}，等待服务端扫描完成后才能记录确认。`
                    : `已上传 ${uploaded.fileId}。`
                );
              })
              .catch((error: unknown) => {
                setEvidenceUploadState(
                  error instanceof Error ? error.message : "确认凭证上传未完成。"
                );
              });
          }}
        />
      </label>
      {evidenceUploadState ? (
        <small className="acceptance-evidence-upload-state">{evidenceUploadState}</small>
      ) : null}
      <label>
        已扫描的凭证文件ID（逗号分隔）
        <input required value={evidence} onChange={(event) => setEvidence(event.target.value)} />
      </label>
      <button className="acceptance-command" type="submit">
        记录确认
      </button>
    </form>
  );
}

function OfflineDraftReviewForm({
  submissionId,
  version,
  status,
  onReview
}: {
  submissionId: string;
  version: number;
  status: string;
  onReview: (submissionId: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const [decision, setDecision] = useState(
    status === "CONFLICT" ? "ACCEPT_WITH_CORRECTION" : "ACCEPT"
  );
  const [reason, setReason] = useState("");
  const [correctedDecision, setCorrectedDecision] = useState("PASS");
  const [correctedMeasuredValue, setCorrectedMeasuredValue] = useState("");
  const [correctedMeasuredUnit, setCorrectedMeasuredUnit] = useState("");
  const [correctedNote, setCorrectedNote] = useState("");
  const [evidenceFileIds, setEvidenceFileIds] = useState("");
  return (
    <form
      className="acceptance-issue-form"
      aria-label="质量复核 SAT 离线草稿"
      onSubmit={(event) => {
        event.preventDefault();
        void onReview(submissionId, {
          version,
          decision,
          reason,
          ...(decision === "ACCEPT_WITH_CORRECTION"
            ? {
                correctedDecision,
                ...(correctedMeasuredValue ? { correctedMeasuredValue } : {}),
                ...(correctedMeasuredUnit ? { correctedMeasuredUnit } : {}),
                ...(correctedNote ? { correctedNote } : {})
              }
            : {}),
          evidenceFileIds: evidenceFileIds
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        });
      }}
    >
      <label>
        复核决定
        <select value={decision} onChange={(event) => setDecision(event.target.value)}>
          {status !== "CONFLICT" ? <option value="ACCEPT">接受</option> : null}
          <option value="ACCEPT_WITH_CORRECTION">修正后接受</option>
          <option value="REJECT">拒绝</option>
        </select>
      </label>
      {decision === "ACCEPT_WITH_CORRECTION" ? (
        <>
          <label>
            修正判定
            <select
              value={correctedDecision}
              onChange={(event) => setCorrectedDecision(event.target.value)}
            >
              <option value="PASS">PASS</option>
              <option value="FAIL">FAIL</option>
              <option value="NA">NA</option>
            </select>
          </label>
          <label>
            修正实测值（留空沿用草稿）
            <input
              value={correctedMeasuredValue}
              onChange={(event) => setCorrectedMeasuredValue(event.target.value)}
            />
          </label>
          <label>
            修正单位（必须与冻结测试项一致）
            <input
              value={correctedMeasuredUnit}
              onChange={(event) => setCorrectedMeasuredUnit(event.target.value)}
            />
          </label>
          <label>
            修正备注
            <input
              value={correctedNote}
              onChange={(event) => setCorrectedNote(event.target.value)}
            />
          </label>
        </>
      ) : null}
      <label>
        复核理由
        <input required value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <label>
        已扫描复核证据文件 ID（逗号分隔）
        <input
          value={evidenceFileIds}
          onChange={(event) => setEvidenceFileIds(event.target.value)}
        />
      </label>
      <button className="acceptance-command" type="submit">
        提交质量复核
      </button>
    </form>
  );
}

function SatOfflineDraftSection({
  selectedBatchId,
  isSat,
  queueState,
  localDrafts,
  onSync,
  onReview,
  commandError
}: {
  selectedBatchId: string | null;
  isSat: boolean;
  queueState: SatOfflineDraftQueueState;
  localDrafts: readonly OfflineSatDraftRecord[];
  onSync?: (draft: OfflineSatDraftRecord) => Promise<void>;
  onReview?: (submissionId: string, body: Record<string, unknown>) => Promise<void>;
  commandError?: string | null;
}) {
  if (!selectedBatchId || !isSat) return null;
  const remoteDrafts =
    queueState.status === "ready" || queueState.status === "stale"
      ? queueState.drafts.filter((draft) => draft.batchId === selectedBatchId)
      : [];
  const canReview =
    (queueState.status === "ready" || queueState.status === "stale") &&
    queueState.allowedActions.includes("REVIEW_OFFLINE_DRAFT");
  return (
    <section className="acceptance-offline-drafts" aria-label="SAT 离线草稿与质量复核">
      <div className="acceptance-section-heading">
        <h2>SAT 离线草稿</h2>
        <span>仅作为待复核输入，不构成正式验收事实</span>
      </div>
      {commandError ? (
        <p className="acceptance-command-error" role="alert">
          {commandError}
        </p>
      ) : null}
      {queueState.status === "denied" ? (
        <p>无权查看服务端离线草稿队列；本地草稿不会因此被删除。</p>
      ) : null}
      {queueState.status === "error" ? (
        <p role="status">服务端草稿队列暂不可用；已保存的本地草稿可在恢复联网后重试。</p>
      ) : null}
      {queueState.status === "loading" ? <p aria-busy="true">正在读取离线草稿状态…</p> : null}
      {localDrafts.length === 0 && remoteDrafts.length === 0 && queueState.status === "empty" ? (
        <p className="acceptance-empty-inline">当前 SAT 批次没有本地草稿或待复核提交。</p>
      ) : null}
      {localDrafts.length > 0 ? (
        <ul className="acceptance-offline-draft-list" aria-label="本地 SAT 离线草稿">
          {localDrafts.map((draft) => (
            <li key={draft.clientDraftId}>
              <strong>{draft.itemId}</strong>
              <span>
                {draft.decision} · {offlineDraftDisplayState(draft)}
              </span>
              <small>客户端采集：{dateTime(draft.capturedAt)}</small>
              {draft.lastError ? <small role="status">{draft.lastError}</small> : null}
              {onSync &&
              (draft.localStatus === "LOCAL_ONLY" || draft.localStatus === "SYNC_FAILED") ? (
                <button
                  className="acceptance-command"
                  type="button"
                  onClick={() => void onSync(draft)}
                >
                  联网提交草稿
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {remoteDrafts.length > 0 ? (
        <ul className="acceptance-offline-draft-list" aria-label="服务端 SAT 离线草稿队列">
          {remoteDrafts.map((draft, index) => {
            const status = typeof draft.status === "string" ? draft.status : "PENDING_REVIEW";
            const snapshot = isRecord(draft.serverResultSnapshot)
              ? draft.serverResultSnapshot
              : null;
            const item = isRecord(draft.item) ? draft.item : {};
            const submissionId = typeof draft.id === "string" ? draft.id : null;
            const version = typeof draft.version === "number" ? draft.version : null;
            return (
              <li key={text(draft.id, `remote-offline-draft-${index}`)}>
                <strong>{text(item.code, text(draft.itemId, "测试项"))}</strong>
                <span>
                  {text(draft.decision)} ·{" "}
                  {offlineDraftDisplayState({
                    localStatus: "SYNCED",
                    serverStatus: status as OfflineSatDraftRecord["serverStatus"]
                  })}
                </span>
                {status === "CONFLICT" ? (
                  <small>
                    已保留离线草稿值和当前服务器修订{" "}
                    {text(snapshot?.currentRevisionId, "无正式结果")}
                    ；质量复核后才可能形成正式修订。
                  </small>
                ) : null}
                {canReview &&
                submissionId &&
                version !== null &&
                ["PENDING_REVIEW", "CONFLICT"].includes(status) &&
                onReview ? (
                  <OfflineDraftReviewForm
                    submissionId={submissionId}
                    version={version}
                    status={status}
                    onReview={onReview}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

export function AcceptancePageContent({
  projectId,
  state,
  selectedBatchId,
  fixture,
  onRetry,
  onCommand,
  commandError,
  reportState,
  onReportCommand,
  reportCommandError,
  offlineDraftQueueState = { projectId, status: "loading" },
  localOfflineDrafts = [],
  onSaveOfflineDraft,
  onSyncOfflineDraft,
  onReviewOfflineDraft,
  offlineDraftError
}: AcceptancePageContentProps) {
  const executeCommand = onCommand ?? (async () => undefined);
  const reportViewState = reportState ?? {
    projectId,
    status: "empty" as const,
    reports: [],
    allowedActions: [],
    fetchedAt: null
  };
  const executeReportCommand = onReportCommand ?? (async () => undefined);
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
      <BatchDetail
        projectId={projectId}
        state={state}
        onCommand={executeCommand}
        onSaveOfflineDraft={onSaveOfflineDraft}
      />
      <SatOfflineDraftSection
        selectedBatchId={selectedBatchId}
        isSat={
          isRecord(state.batchDetail?.batch) && state.batchDetail.batch.acceptanceType === "SAT"
        }
        queueState={offlineDraftQueueState}
        localDrafts={localOfflineDrafts}
        onSync={onSyncOfflineDraft}
        onReview={onReviewOfflineDraft}
        commandError={offlineDraftError}
      />
      <ReportList
        projectId={projectId}
        state={reportViewState}
        acceptanceState={state}
        selectedBatchId={selectedBatchId}
        onCommand={executeReportCommand}
        commandError={reportCommandError}
      />
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

async function fetchAcceptanceReportSource(path: string): Promise<AcceptanceReportFetchResult> {
  try {
    const response = await fetch(path, { cache: "no-store" });
    const body = await response.json().catch(() => undefined);
    return {
      status: response.status,
      body,
      fetchedAt: new Date().toISOString(),
      stale: false,
      retryable: response.status === 502 || response.status === 503 || response.status === 504
    };
  } catch {
    return { status: 0, fetchedAt: null, stale: false, retryable: true };
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

export async function loadAcceptanceReportPageState(
  projectId: string
): Promise<AcceptanceReportPageState> {
  const result = await fetchAcceptanceReportSource(
    `/api/projects/${encodeURIComponent(projectId)}/acceptance/reports`
  );
  return buildAcceptanceReportPageState({ projectId, result });
}

export async function loadSatOfflineDraftQueueState(
  projectId: string
): Promise<SatOfflineDraftQueueState> {
  try {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/acceptance/offline-drafts?limit=100`,
      { cache: "no-store" }
    );
    const body = await response.json().catch(() => undefined);
    return buildSatOfflineDraftQueueState({
      projectId,
      result: {
        status: response.ok && body === undefined ? 502 : response.status,
        body,
        fetchedAt: new Date().toISOString(),
        stale: false,
        retryable: response.status === 502 || response.status === 503 || response.status === 504
      }
    });
  } catch {
    return buildSatOfflineDraftQueueState({
      projectId,
      result: { status: 0, fetchedAt: null, retryable: true }
    });
  }
}

export function AcceptancePageClient({
  projectId,
  initialState,
  initialReportState
}: AcceptancePageClientProps) {
  const searchParams = useSearchParams();
  const requestedBatchId = searchParams.get("batch");
  const fixture = resolveAcceptanceFixture(searchParams.get("fixture"), process.env.NODE_ENV);
  const reportFixture = resolveAcceptanceReportFixture(
    searchParams.get("fixture"),
    process.env.NODE_ENV
  );
  const [state, setState] = useState<AcceptancePageState>(
    initialState ?? { projectId, status: "loading" }
  );
  const [reportState, setReportState] = useState<AcceptanceReportPageState>(
    initialReportState ?? { projectId, status: "loading" }
  );
  const [commandError, setCommandError] = useState<string | null>(null);
  const [reportCommandError, setReportCommandError] = useState<string | null>(
    reportFixture === "conflict" ? "报告或确认已被其他成员更新，请刷新后重试。" : null
  );
  const [offlineDraftQueueState, setOfflineDraftQueueState] = useState<SatOfflineDraftQueueState>({
    projectId,
    status: "loading"
  });
  const [localOfflineDrafts, setLocalOfflineDrafts] = useState<OfflineSatDraftRecord[]>([]);
  const [offlineDraftError, setOfflineDraftError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const [next, nextReports] = await Promise.all([
      loadAcceptancePageState(projectId, requestedBatchId),
      loadAcceptanceReportPageState(projectId)
    ]);
    setState(next);
    setReportState(nextReports);
  }, [projectId, requestedBatchId]);
  useEffect(() => {
    if (initialState) return;
    let cancelled = false;
    void Promise.all([
      loadAcceptancePageState(projectId, requestedBatchId),
      loadAcceptanceReportPageState(projectId)
    ]).then(([next, nextReports]) => {
      if (!cancelled) setState(next);
      if (!cancelled) setReportState(nextReports);
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
  const refreshOfflineDrafts = useCallback(
    async (batchId: string | null) => {
      const queue = await loadSatOfflineDraftQueueState(projectId);
      const local = batchId ? await listOfflineSatDrafts(projectId, batchId).catch(() => []) : [];
      setOfflineDraftQueueState(queue);
      setLocalOfflineDrafts(local);
    },
    [projectId]
  );
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      loadSatOfflineDraftQueueState(projectId),
      selectedBatchId
        ? listOfflineSatDrafts(projectId, selectedBatchId).catch(() => [])
        : Promise.resolve([])
    ]).then(([queue, local]) => {
      if (cancelled) return;
      setOfflineDraftQueueState(queue);
      setLocalOfflineDrafts(local);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedBatchId]);
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
  const runReportCommand = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      setReportCommandError(null);
      try {
        const response = await fetch(path, {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify(body)
        });
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string; code?: string };
        } | null;
        if (!response.ok) {
          setReportCommandError(
            response.status === 409
              ? "报告或确认已被其他成员更新，请刷新后重试。"
              : (payload?.error?.message ?? "报告命令未完成。")
          );
          return;
        }
        await reload();
      } catch {
        setReportCommandError("报告命令暂时无法连接服务，请稍后重试。");
      }
    },
    [reload]
  );
  const saveOfflineDraft = useCallback(
    async (
      draft: Omit<
        OfflineSatDraftRecord,
        "localStatus" | "serverStatus" | "submissionId" | "lastError" | "updatedAt"
      >
    ) => {
      setOfflineDraftError(null);
      try {
        const saved = await saveOfflineSatDraft(createOfflineSatDraftRecord(draft));
        setLocalOfflineDrafts((current) => [
          saved,
          ...current.filter((item) => item.clientDraftId !== saved.clientDraftId)
        ]);
      } catch (error) {
        setOfflineDraftError(error instanceof Error ? error.message : "无法保存 SAT 离线草稿。");
      }
    },
    []
  );
  const syncOfflineDraft = useCallback(
    async (draft: OfflineSatDraftRecord) => {
      setOfflineDraftError(null);
      try {
        const pending = await markOfflineSatDraftForSync(draft.clientDraftId);
        setLocalOfflineDrafts((current) =>
          current.map((item) => (item.clientDraftId === pending.clientDraftId ? pending : item))
        );
        const response = await fetch(
          `/api/projects/${encodeURIComponent(draft.projectId)}/acceptance/offline-drafts`,
          {
            method: "POST",
            cache: "no-store",
            headers: { "content-type": "application/json", "idempotency-key": draft.clientDraftId },
            body: JSON.stringify({
              clientDraftId: draft.clientDraftId,
              batchId: draft.batchId,
              itemId: draft.itemId,
              baselineBatchVersion: draft.baselineBatchVersion,
              baselineResultRevisionId: draft.baselineResultRevisionId,
              decision: draft.decision,
              measuredValue: draft.measuredValue,
              measuredUnit: draft.measuredUnit,
              note: draft.note,
              capturedAt: draft.capturedAt
            })
          }
        );
        const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        const submission = payload && isRecord(payload.submission) ? payload.submission : null;
        const status = payload?.status;
        if (
          !response.ok ||
          !submission ||
          typeof submission.id !== "string" ||
          typeof status !== "string"
        ) {
          const message =
            isRecord(payload?.error) && typeof payload.error.message === "string"
              ? payload.error.message
              : "离线草稿未能提交，可在恢复联网后重试。";
          throw new Error(message);
        }
        const synced = await markOfflineSatDraftSyncResult({
          clientDraftId: draft.clientDraftId,
          submissionId: submission.id,
          serverStatus: status as OfflineSatDraftRecord["serverStatus"] &
            NonNullable<OfflineSatDraftRecord["serverStatus"]>
        });
        setLocalOfflineDrafts((current) =>
          current.map((item) => (item.clientDraftId === synced.clientDraftId ? synced : item))
        );
        await refreshOfflineDrafts(draft.batchId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "离线草稿同步失败。";
        const failed = await markOfflineSatDraftSyncFailed(draft.clientDraftId, message).catch(
          () => null
        );
        if (failed)
          setLocalOfflineDrafts((current) =>
            current.map((item) => (item.clientDraftId === failed.clientDraftId ? failed : item))
          );
        setOfflineDraftError(message);
      }
    },
    [refreshOfflineDrafts]
  );
  const reviewOfflineDraft = useCallback(
    async (submissionId: string, body: Record<string, unknown>) => {
      setOfflineDraftError(null);
      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/acceptance/offline-drafts/${encodeURIComponent(submissionId)}/review`,
          {
            method: "POST",
            cache: "no-store",
            headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
            body: JSON.stringify(body)
          }
        );
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? "离线草稿复核未完成。");
        }
        await Promise.all([reload(), refreshOfflineDrafts(selectedBatchId)]);
      } catch (error) {
        setOfflineDraftError(error instanceof Error ? error.message : "离线草稿复核未完成。");
      }
    },
    [projectId, refreshOfflineDrafts, reload, selectedBatchId]
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
      reportState={reportState}
      onReportCommand={runReportCommand}
      reportCommandError={reportCommandError}
      offlineDraftQueueState={offlineDraftQueueState}
      localOfflineDrafts={localOfflineDrafts}
      onSaveOfflineDraft={saveOfflineDraft}
      onSyncOfflineDraft={syncOfflineDraft}
      onReviewOfflineDraft={reviewOfflineDraft}
      offlineDraftError={offlineDraftError}
    />
  );
}
