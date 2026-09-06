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

export function parseRetestObservationStart(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!daysInMonth || day < 1 || day > daysInMonth || hour > 23 || minute > 59) return null;
  const date = new Date(`${value.trim()}:00+08:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function frozenSourceSnapshot(issue: IssueDetail): Record<string, unknown> | null {
  if (!Array.isArray(issue.history)) return null;
  for (const entry of issue.history) {
    if (!isRecord(entry) || !isRecord(entry.snapshot)) continue;
    const snapshot = entry.snapshot;
    if (isRecord(snapshot.sourceSnapshot)) return snapshot.sourceSnapshot;
  }
  return null;
}

function snapshotValue(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value.map((item) => snapshotValue(item)).filter((item) => item !== "未提供");
    return items.length ? items.join("、") : "无数据";
  }
  if (isRecord(value)) {
    try {
      return JSON.stringify(value) ?? "无数据";
    } catch {
      return "无数据";
    }
  }
  return "无数据";
}

const FROZEN_SNAPSHOT_FIELDS = [
  ["LOCKED checksum", "lockedChecksum"],
  ["目标版本", "targetVersionId"],
  ["目标 UPH", "targetUph"],
  ["实际良品 UPH", "actualGoodUph"],
  ["短缺 UPH", "shortfallUph"],
  ["根实测能力 UPH", "rootMeasuredCapacityUph"],
  ["A / 可用率", "utilizationA"],
  ["公式版本", "formulaVersionId"],
  ["公式 checksum", "formulaChecksum"],
  ["引擎", "engineCode"],
  ["警告", "warnings"],
  ["瓶颈", "bottleneck"],
  ["第二瓶颈", "secondBottleneck"],
  ["模块 FPY", "moduleFpy"],
  ["模块 CT", "moduleCt"],
  ["并联组", "parallelGroups"],
  ["归约层级", "reductionLevels"],
  ["瓶颈转移", "bottleneckTransfer"],
  ["分析创建时间", "analysisCreatedAt"]
] as const;

export function IssueDetailPageClient({
  projectId,
  issueId
}: {
  projectId: string;
  issueId: string;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [retestOpen, setRetestOpen] = useState(false);
  const [retestMessage, setRetestMessage] = useState<string | null>(null);
  const [retestBatchId, setRetestBatchId] = useState<string | null>(null);
  const [retestBusy, setRetestBusy] = useState(false);

  const loadIssue = useCallback(async () => {
    setStatus("loading");
    try {
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
    } catch {
      setStatus("error");
    }
  }, [issueId, projectId]);

  async function createRetest(form: HTMLFormElement) {
    if (!issue) return;
    const data = new FormData(form);
    const body = {
      issueVersion: Number(issue.version),
      batchNumber: String(data.get("batchNumber") ?? "").trim(),
      plannedProductionSeconds: Number(data.get("plannedProductionSeconds") ?? 0),
      planDeclarationReason: String(data.get("planDeclarationReason") ?? "").trim(),
      observationStartedAt: parseRetestObservationStart(data.get("observationStartedAt")),
      observationEndedAt: null,
      timezone: String(data.get("timezone") ?? "Asia/Shanghai"),
      reason: String(data.get("reason") ?? "").trim()
    };
    setRetestBusy(true);
    setRetestMessage(null);
    setRetestBatchId(null);
    if (!body.observationStartedAt) {
      setRetestBusy(false);
      setRetestMessage("观察开始时间无效，请重新选择有效时间。");
      return;
    }
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/uph-retests`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
            "if-match": String(issue.version)
          },
          body: JSON.stringify(body)
        }
      );
      const payload = await response.json().catch(() => null);
      setRetestBusy(false);
      if (!response.ok) {
        setRetestMessage(
          text(
            isRecord(payload) && payload.error && isRecord(payload.error)
              ? payload.error.message
              : null,
            "复测批次创建失败。"
          )
        );
        return;
      }
      const batchId =
        isRecord(payload) && typeof payload.batchId === "string" ? payload.batchId : null;
      setRetestBatchId(batchId);
      setRetestMessage(batchId ? `复测批次已创建：${batchId}` : "复测批次已创建。");
      await loadIssue();
    } catch {
      setRetestMessage("复测批次创建失败，请检查网络后重试。");
    } finally {
      setRetestBusy(false);
    }
  }

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
          <section className="issue-detail-section" aria-labelledby="uph-evidence-title">
            <h2 id="uph-evidence-title">UPH冻结证据</h2>
            {frozenSourceSnapshot(issue) ? (
              <dl className="issue-detail-snapshot" aria-label="UPH冻结证据明细">
                {FROZEN_SNAPSHOT_FIELDS.map(([label, key]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>{snapshotValue(frozenSourceSnapshot(issue)?.[key])}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {Array.isArray(issue.relations) &&
              issue.relations
                .filter(
                  (r) =>
                    isRecord(r) &&
                    ["UPH_SOURCE_BATCH", "UPH_ANALYSIS", "UPH_RETEST_BATCH"].includes(
                      String(r.relationType)
                    )
                )
                .map((relation, index) => (
                  <details key={String(relation.id ?? index)}>
                    <summary>
                      {String(relation.relationType)} ·{" "}
                      <span className="uph-breakable">{String(relation.targetId ?? "")}</span>
                    </summary>
                    <p className="uph-breakable">
                      关联目标：{String(relation.targetId ?? "未提供")}
                    </p>
                  </details>
                ))}
            {Array.isArray(issue.history) &&
            issue.history.some(
              (entry) =>
                isRecord(entry) && isRecord(entry.snapshot) && "sourceSnapshot" in entry.snapshot
            ) ? (
              <p>已保存源快照。</p>
            ) : (
              <p>暂无可读冻结快照。</p>
            )}
          </section>
          <section className="issue-detail-section">
            {issue.category === "PERFORMANCE" &&
            issue.sourceType === "PROJECT" &&
            issue.status !== "CLOSED" ? (
              <button
                type="button"
                className="issue-capture-secondary"
                onClick={() => setRetestOpen((value) => !value)}
                aria-expanded={retestOpen}
              >
                创建复测批次
              </button>
            ) : null}
            {retestOpen ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void createRetest(event.currentTarget);
                }}
              >
                <label>
                  批次号
                  <input name="batchNumber" required maxLength={191} />
                </label>
                <label>
                  计划秒数
                  <input name="plannedProductionSeconds" type="number" min="1" required />
                </label>
                <label>
                  计划说明
                  <input name="planDeclarationReason" required maxLength={1024} />
                </label>
                <label>
                  观察开始
                  <input name="observationStartedAt" type="datetime-local" required />
                </label>
                <label>
                  时区（固定）
                  <input
                    name="timezone"
                    value="Asia/Shanghai"
                    readOnly
                    required
                    aria-describedby="retest-timezone-help"
                  />
                  <small id="retest-timezone-help">复测时间按 Asia/Shanghai 解释。</small>
                </label>
                <label>
                  复测原因
                  <input name="reason" required maxLength={1024} />
                </label>
                <button type="submit" className="issue-capture-primary" disabled={retestBusy}>
                  {retestBusy ? "创建中…" : "提交复测"}
                </button>
              </form>
            ) : null}
            {retestMessage ? (
              <p role="status" className="issue-detail-state">
                {retestMessage}
                {retestBatchId ? (
                  <>
                    {" "}
                    <a
                      href={`/projects/${encodeURIComponent(projectId)}/uph?batchId=${encodeURIComponent(retestBatchId)}`}
                    >
                      返回UPH页面查看新DRAFT批次
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
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
