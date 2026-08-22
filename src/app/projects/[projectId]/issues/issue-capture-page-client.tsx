"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type IssueCaptureStep = "capture" | "confirm" | "submitted";
type IssueCategory = "SAFETY" | "FUNCTION" | "PERFORMANCE" | "APPEARANCE" | "DELIVERY_COMPLETENESS";
type IssueSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type BrowserFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type UploadableFile = Blob & { name: string; type: string; size: number };

const CATEGORY_LABELS: Record<IssueCategory, string> = {
  SAFETY: "安全",
  FUNCTION: "功能",
  PERFORMANCE: "性能",
  APPEARANCE: "外观",
  DELIVERY_COMPLETENESS: "交付完整性"
};

const SEVERITY_LABELS: Record<IssueSeverity, string> = {
  LOW: "低",
  MEDIUM: "中",
  HIGH: "高",
  CRITICAL: "严重"
};

export function issueCaptureStepLabel(step: IssueCaptureStep) {
  return step === "capture" ? "录入素材" : step === "confirm" ? "确认文字" : "已提交";
}

export function buildIssueCapturePayload(input: {
  inputText: string;
  voiceFileId: string | null;
  mediaFileIds: readonly string[];
}) {
  const inputText = input.inputText.trim();
  const voiceFileId = input.voiceFileId?.trim() || null;
  const mediaFileIds = input.mediaFileIds.map((id) => id.trim()).filter(Boolean);
  if (!inputText && !voiceFileId) throw new Error("请输入文字或选择语音。");
  if (new Set(mediaFileIds).size !== mediaFileIds.length) {
    throw new Error("媒体附件不能重复。");
  }
  return { inputText: inputText || null, voiceFileId: voiceFileId || null, mediaFileIds };
}

export function buildIssueConfirmationPayload(input: {
  title: string;
  confirmedText: string;
  category: IssueCategory;
  severity: IssueSeverity;
  tags: string;
}) {
  const confirmedText = input.confirmedText.trim();
  const title = input.title.trim() || confirmedText.slice(0, 191);
  if (!confirmedText) throw new Error("请先确认问题文字。");
  if (!title) throw new Error("请填写问题标题。");
  const tags = input.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return {
    title,
    confirmedText,
    category: input.category,
    severity: input.severity,
    phenomenonDescription: confirmedText,
    rootCauseCategory: null,
    rootCauseDescription: null,
    tags
  };
}

function idempotencyKey(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function jsonOrError(response: Response) {
  const body = await response.json().catch(() => null);
  if (response.ok) return body as Record<string, unknown>;
  const error =
    body && typeof body === "object" && body !== null && "error" in body
      ? (body as { error?: { message?: string } }).error?.message
      : undefined;
  throw new Error(typeof error === "string" ? error : "请求未完成，请稍后重试。");
}

export async function uploadIssueCaptureFile(input: {
  projectId: string;
  file: UploadableFile;
  fetchImpl?: BrowserFetch;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const mimeType = input.file.type.trim().toLowerCase() || "application/octet-stream";
  const base = `/api/projects/${encodeURIComponent(input.projectId)}/files/uploads`;
  const started = await jsonOrError(
    await fetchImpl(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey("issue-file")
      },
      body: JSON.stringify({
        originalName: input.file.name.trim(),
        mimeType,
        size: input.file.size,
        sensitivity: "RESTRICTED"
      })
    })
  );
  const upload = started.upload as {
    sessionId?: string;
    expectedParts?: number;
    partSize?: number;
  };
  const file = started.file as { id?: string };
  if (!upload?.sessionId || !upload.expectedParts || !upload.partSize || !file?.id) {
    throw new Error("文件上传会话响应无效。");
  }
  const parts: Array<{ partNumber: number; etag: string; size: number }> = [];
  for (let partNumber = 1; partNumber <= upload.expectedParts; partNumber += 1) {
    const part = await jsonOrError(
      await fetchImpl(`${base}/${encodeURIComponent(upload.sessionId)}/parts/${partNumber}`, {
        method: "POST"
      })
    );
    const signed = part as { expectedSize?: number; uploadUrl?: string; partNumber?: number };
    if (!signed.expectedSize || !signed.uploadUrl) throw new Error("文件分片地址无效。");
    const start = (partNumber - 1) * upload.partSize;
    const uploaded = await fetchImpl(signed.uploadUrl, {
      method: "PUT",
      headers: { "content-type": mimeType },
      body: input.file.slice(start, start + signed.expectedSize)
    });
    const etag = uploaded.headers.get("etag");
    if (!uploaded.ok || !etag) throw new Error("文件分片上传失败。");
    parts.push({ partNumber, etag, size: signed.expectedSize });
  }
  const completed = await jsonOrError(
    await fetchImpl(`${base}/${encodeURIComponent(upload.sessionId)}/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey("issue-file-complete")
      },
      body: JSON.stringify({ mimeType, size: input.file.size, parts })
    })
  );
  const completedFile = completed.file as { id?: string; status?: string };
  return {
    fileId: completedFile?.id ?? file.id,
    status: completedFile?.status ?? "PENDING_SCAN"
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function captureVersion(value: unknown) {
  return isRecord(value) && typeof value.version === "number" ? value.version : null;
}

export function IssueCapturePageClient({ projectId }: { projectId: string }) {
  const [step, setStep] = useState<IssueCaptureStep>("capture");
  const [inputText, setInputText] = useState("");
  const [voiceFile, setVoiceFile] = useState<UploadableFile | null>(null);
  const [mediaFiles, setMediaFiles] = useState<UploadableFile[]>([]);
  const [uploadedVoiceId, setUploadedVoiceId] = useState<string | null>(null);
  const [uploadedMediaIds, setUploadedMediaIds] = useState<string[]>([]);
  const [awaitingScan, setAwaitingScan] = useState(false);
  const [capture, setCapture] = useState<Record<string, unknown> | null>(null);
  const [confirmedText, setConfirmedText] = useState("");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<IssueCategory>("FUNCTION");
  const [severity, setSeverity] = useState<IssueSeverity>("MEDIUM");
  const [tags, setTags] = useState("");
  const [issue, setIssue] = useState<Record<string, unknown> | null>(null);
  const [issues, setIssues] = useState<readonly Record<string, unknown>[]>([]);
  const [recentStatus, setRecentStatus] = useState<
    "loading" | "ready" | "empty" | "denied" | "error"
  >("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const voiceInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);

  const fetchIssues = useCallback(async () => {
    setRecentStatus("loading");
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/issues?limit=20`);
    const body = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      setIssues([]);
      setRecentStatus("denied");
      return;
    }
    if (!response.ok) {
      setIssues([]);
      setRecentStatus("error");
      return;
    }
    const nextIssues =
      isRecord(body) && Array.isArray(body.issues) ? body.issues.filter(isRecord) : [];
    setIssues(nextIssues);
    setRecentStatus(nextIssues.length > 0 ? "ready" : "empty");
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchIssues(), 0);
    return () => window.clearTimeout(timer);
  }, [fetchIssues]);

  const stepIndex = useMemo(() => (step === "capture" ? 0 : step === "confirm" ? 1 : 2), [step]);

  const createCapture = async () => {
    setError(null);
    setBusy(true);
    try {
      let nextVoiceId = uploadedVoiceId;
      let nextMediaIds = uploadedMediaIds;
      if (!awaitingScan) {
        const uploadedVoice = voiceFile
          ? await uploadIssueCaptureFile({ projectId, file: voiceFile })
          : null;
        const uploadedMedia = [];
        for (const file of mediaFiles) {
          uploadedMedia.push(await uploadIssueCaptureFile({ projectId, file }));
        }
        nextVoiceId = uploadedVoice?.fileId ?? null;
        nextMediaIds = uploadedMedia.map((item) => item.fileId);
        setUploadedVoiceId(nextVoiceId);
        setUploadedMediaIds(nextMediaIds);
        const pendingScan = [uploadedVoice, ...uploadedMedia].some(
          (uploaded) => uploaded && uploaded.status !== "AVAILABLE"
        );
        if (pendingScan) {
          setAwaitingScan(true);
          throw new Error("附件已上传，正在进行安全扫描；扫描完成后请重新检查附件。");
        }
      }
      const payload = buildIssueCapturePayload({
        inputText,
        voiceFileId: nextVoiceId,
        mediaFileIds: nextMediaIds
      });
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/issue-captures`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey("issue-capture")
          },
          body: JSON.stringify(payload)
        }
      );
      const body = await jsonOrError(response);
      const nextCapture = isRecord(body.capture) ? body.capture : null;
      if (!nextCapture) throw new Error("录入响应缺少 capture。");
      setCapture(nextCapture);
      setAwaitingScan(false);
      setConfirmedText(typeof nextCapture.inputText === "string" ? nextCapture.inputText : "");
      setTitle(
        typeof nextCapture.inputText === "string" ? nextCapture.inputText.slice(0, 191) : ""
      );
      setStep("confirm");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "录入未完成，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const submitIssue = async () => {
    setError(null);
    setBusy(true);
    try {
      if (!capture || typeof capture.id !== "string")
        throw new Error("录入状态已失效，请重新开始。");
      const version = captureVersion(capture);
      if (version === null) throw new Error("录入版本无效，请重新开始。");
      const payload = buildIssueConfirmationPayload({
        title,
        confirmedText,
        category,
        severity,
        tags
      });
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/issues`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "if-match": String(version),
          "idempotency-key": idempotencyKey("issue-create")
        },
        body: JSON.stringify({ ...payload, captureId: capture.id, captureVersion: version })
      });
      const body = await jsonOrError(response);
      setIssue(isRecord(body.issue) ? body.issue : null);
      setStep("submitted");
      await fetchIssues();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交未完成，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStep("capture");
    setInputText("");
    setVoiceFile(null);
    setMediaFiles([]);
    setUploadedVoiceId(null);
    setUploadedMediaIds([]);
    setAwaitingScan(false);
    setCapture(null);
    setConfirmedText("");
    setTitle("");
    setTags("");
    setIssue(null);
    setError(null);
    if (voiceInputRef.current) voiceInputRef.current.value = "";
    if (mediaInputRef.current) mediaInputRef.current.value = "";
  };

  return (
    <main className="issue-capture-page">
      <header className="issue-capture-header">
        <div>
          <p className="issue-capture-eyebrow">PROJECT ISSUES</p>
          <h1>现场问题</h1>
          <p>用文字或语音快速记录，确认文字后才会形成正式问题。</p>
        </div>
        <span className="issue-capture-project">项目 {projectId}</span>
      </header>

      <ol className="issue-capture-steps" aria-label="问题录入步骤">
        {(["capture", "confirm", "submitted"] as const).map((candidate, index) => (
          <li key={candidate} className={index <= stepIndex ? "is-current" : undefined}>
            <span>{index + 1}</span>
            {issueCaptureStepLabel(candidate)}
          </li>
        ))}
      </ol>

      {error ? (
        <p className="issue-capture-error" role="alert">
          {error}
        </p>
      ) : null}

      {step === "capture" ? (
        <section className="issue-capture-form" aria-labelledby="issue-capture-title">
          <div className="issue-capture-section-heading">
            <div>
              <p className="issue-capture-kicker">STEP 01</p>
              <h2 id="issue-capture-title">先记录现场事实</h2>
            </div>
            <span>文字、语音至少一项</span>
          </div>
          <label>
            文字记录
            <textarea
              value={inputText}
              onChange={(event) => setInputText(event.target.value)}
              placeholder="例如：输送带进入工位时卡滞"
              rows={5}
            />
          </label>
          <div className="issue-capture-input-grid">
            <label className="issue-capture-file-field">
              <span>语音记录</span>
              <input
                ref={voiceInputRef}
                type="file"
                accept="audio/*"
                onChange={(event) => {
                  setVoiceFile(event.target.files?.[0] ?? null);
                  setUploadedVoiceId(null);
                  setAwaitingScan(false);
                }}
              />
              <small>{voiceFile ? voiceFile.name : "选择一段现场语音"}</small>
            </label>
            <label className="issue-capture-file-field">
              <span>照片或视频（可选）</span>
              <input
                ref={mediaInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                onChange={(event) => {
                  setMediaFiles(Array.from(event.target.files ?? []));
                  setUploadedMediaIds([]);
                  setAwaitingScan(false);
                }}
              />
              <small>
                {mediaFiles.length ? `已选择 ${mediaFiles.length} 个附件` : "补充现场证据"}
              </small>
            </label>
          </div>
          <p className="issue-capture-note">语音不会自动成为问题文字；下一步必须由你确认文字。</p>
          <button
            className="issue-capture-command"
            type="button"
            onClick={() => void createCapture()}
            disabled={busy}
          >
            {busy ? "保存中…" : awaitingScan ? "重新检查附件" : "保存并确认文字"}
          </button>
        </section>
      ) : null}

      {step === "confirm" ? (
        <section className="issue-capture-form" aria-labelledby="issue-confirm-title">
          <div className="issue-capture-section-heading">
            <div>
              <p className="issue-capture-kicker">STEP 02</p>
              <h2 id="issue-confirm-title">确认问题文字</h2>
            </div>
            <span>确认后写入正式问题</span>
          </div>
          <label>
            确认文字
            <textarea
              value={confirmedText}
              onChange={(event) => setConfirmedText(event.target.value)}
              rows={6}
            />
          </label>
          <div className="issue-capture-input-grid">
            <label>
              问题标题
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={191}
              />
            </label>
            <label>
              一级分类
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value as IssueCategory)}
              >
                {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              严重度
              <select
                value={severity}
                onChange={(event) => setSeverity(event.target.value as IssueSeverity)}
              >
                {Object.entries(SEVERITY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            标签（用逗号分隔，可选）
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="卡滞,现场"
            />
          </label>
          <div className="issue-capture-actions">
            <button
              className="issue-capture-secondary"
              type="button"
              onClick={reset}
              disabled={busy}
            >
              重新录入
            </button>
            <button
              className="issue-capture-command"
              type="button"
              onClick={() => void submitIssue()}
              disabled={busy}
            >
              {busy ? "提交中…" : "提交问题"}
            </button>
          </div>
        </section>
      ) : null}

      {step === "submitted" ? (
        <section className="issue-capture-success" aria-live="polite">
          <p className="issue-capture-kicker">STEP 03</p>
          <h2>问题已提交</h2>
          <p>确认文字已成为正式问题事实，后续分类和责任处理可继续在问题详情中完成。</p>
          {issue && typeof issue.id === "string" ? (
            <a
              href={`/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issue.id)}`}
            >
              查看问题详情
            </a>
          ) : null}
          <button className="issue-capture-secondary" type="button" onClick={reset}>
            继续记录问题
          </button>
        </section>
      ) : null}

      <section className="issue-capture-recent" aria-labelledby="recent-issues-title">
        <div className="issue-capture-section-heading">
          <div>
            <p className="issue-capture-kicker">RECENT</p>
            <h2 id="recent-issues-title">最近问题</h2>
          </div>
          <button
            type="button"
            className="issue-capture-refresh"
            onClick={() => void fetchIssues()}
          >
            刷新
          </button>
        </div>
        {recentStatus === "loading" ? (
          <p className="issue-capture-empty" role="status" aria-live="polite">
            正在读取问题清单。
          </p>
        ) : recentStatus === "denied" ? (
          <p className="issue-capture-empty" role="status">
            当前身份没有问题读取权限。
          </p>
        ) : recentStatus === "error" ? (
          <p className="issue-capture-empty" role="alert">
            问题清单暂时不可用，请刷新后重试。
          </p>
        ) : issues.length === 0 ? (
          <p className="issue-capture-empty">暂无已提交问题。</p>
        ) : (
          <ul>
            {issues.slice(0, 8).map((item, index) => (
              <li key={typeof item.id === "string" ? item.id : `issue-${index}`}>
                <a
                  href={
                    typeof item.id === "string"
                      ? `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(item.id)}`
                      : undefined
                  }
                >
                  <strong>{typeof item.title === "string" ? item.title : "未命名问题"}</strong>
                  <span>
                    {typeof item.status === "string" ? item.status : "状态待确认"} ·{" "}
                    {typeof item.severity === "string" ? item.severity : "未定级"}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
