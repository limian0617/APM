"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  buildDrawingWorkspacePageState,
  type DrawingWorkspacePageState,
  toDrawingWorkspaceFetchResult
} from "@/modules/drawings/contracts/drawing-workspace-page-state";

type DrawingWorkspaceClientProps = Readonly<{
  projectId: string;
  initialState: DrawingWorkspacePageState | null;
  initialCommandError?: string | null;
}>;

type CommandInput = {
  path: string;
  method: "POST" | "PUT" | "PATCH";
  body: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = "未提供") {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value : fallback;
}

function id(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function records(value: unknown, key?: string): readonly Record<string, unknown>[] {
  const candidate = key && isRecord(value) ? value[key] : value;
  return Array.isArray(candidate) ? candidate.filter(isRecord) : [];
}

function allowedActions(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((action): action is string => typeof action === "string")
    : [];
}

function encodeProjectPath(projectId: string, suffix: string) {
  return `/api/projects/${encodeURIComponent(projectId)}${suffix}`;
}

function commandMessage(status: number, body: unknown) {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = typeof error?.code === "string" ? error.code : null;
  if (status === 409 && code === "VERSION_CONFLICT") return "数据已被其他成员更新，请刷新后重试。";
  if (status === 409) return "当前状态不允许此操作，或数据已发生冲突。";
  return typeof error?.message === "string" ? error.message : "操作未完成，请稍后重试。";
}

function clientIdempotencyKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `drawing-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function fetchWorkspaceSource(path: string) {
  try {
    const response = await fetch(path, { cache: "no-store" });
    const body = await response.json().catch(() => undefined);
    return toDrawingWorkspaceFetchResult({
      status: response.status,
      body,
      fetchedAt: new Date().toISOString()
    });
  } catch {
    return toDrawingWorkspaceFetchResult({ status: 503 });
  }
}

export async function loadDrawingWorkspaceState(
  projectId: string
): Promise<DrawingWorkspacePageState> {
  const encodedProjectId = encodeURIComponent(projectId);
  const [drawings, selections, categories, processTags] = await Promise.all([
    fetchWorkspaceSource(`/api/projects/${encodedProjectId}/drawings?limit=100`),
    fetchWorkspaceSource(`/api/projects/${encodedProjectId}/drawing-selections`),
    fetchWorkspaceSource("/api/configuration/manufacturing-categories?activeOnly=true"),
    fetchWorkspaceSource("/api/configuration/process-tags?activeOnly=true")
  ]);
  return buildDrawingWorkspacePageState({
    projectId,
    drawings,
    selections,
    categories,
    processTags,
    suppliers: toDrawingWorkspaceFetchResult({ status: 200, body: { matches: [] } }),
    supplierMatchesRequested: false
  });
}

export function supplierMatchPathForDrawing(
  projectId: string,
  drawing: Record<string, unknown> | null
): string | null {
  const classification =
    drawing && isRecord(drawing.classification) ? drawing.classification : null;
  const category =
    classification && isRecord(classification.category) ? classification.category : null;
  const categoryCode = typeof category?.code === "string" ? category.code.trim().toUpperCase() : "";
  if (!/^[A-Z][A-Z0-9._-]{0,63}$/u.test(categoryCode)) return null;
  const processTagCodes = Array.isArray(classification?.processTags)
    ? classification.processTags
        .filter(isRecord)
        .map((tag) => (typeof tag.code === "string" ? tag.code.trim().toUpperCase() : ""))
        .filter((code) => /^[A-Z][A-Z0-9._-]{0,63}$/u.test(code))
        .sort()
    : [];
  const query = new URLSearchParams({ categoryCode });
  if (processTagCodes.length) query.set("processTagCodes", processTagCodes.join(","));
  return `${encodeProjectPath(projectId, "/drawing-supplier-matches")}?${query.toString()}`;
}

function StatePanel({
  state,
  onRetry
}: {
  state: Extract<DrawingWorkspacePageState, { status: "loading" | "denied" | "error" }>;
  onRetry: () => void;
}) {
  const labels = {
    loading: "图纸工作区加载中",
    denied: "无权查看项目图纸工作区",
    error: "图纸工作区暂不可用"
  } as const;
  return (
    <main
      className="drawing-workspace drawing-workspace-state"
      aria-busy={state.status === "loading"}
    >
      <section className="drawing-state-panel" aria-labelledby="drawing-state-title">
        <p className="drawing-eyebrow">DRAWING WORKSPACE</p>
        <h1 id="drawing-state-title">{labels[state.status]}</h1>
        <p>
          {state.status === "denied"
            ? "当前身份没有此项目的受控图纸读取权限。"
            : state.status === "loading"
              ? "正在读取项目内图纸、选图集合和配置状态。"
              : "请在数据恢复后重新加载。"}
        </p>
        {state.status === "error" && state.retryable ? (
          <button type="button" className="drawing-command" onClick={onRetry}>
            重新加载
          </button>
        ) : null}
      </section>
    </main>
  );
}

function AreaNotice({
  label,
  state
}: {
  label: string;
  state: { status: "restricted" } | { status: "error"; retryable: boolean };
}) {
  return (
    <p className="drawing-area-notice" role="status">
      {state.status === "restricted"
        ? `${label}受限，服务端未授权显示其内容。`
        : `${label}暂不可用${state.retryable ? "，可重新加载" : ""}。`}
    </p>
  );
}

function ClassificationForm({
  projectId,
  drawing,
  categories,
  processTags,
  onCommand,
  onCompleted
}: {
  projectId: string;
  drawing: Record<string, unknown>;
  categories: readonly Record<string, unknown>[];
  processTags: readonly Record<string, unknown>[];
  onCommand: (input: CommandInput) => Promise<void>;
  onCompleted: () => void;
}) {
  const classification = isRecord(drawing.classification) ? drawing.classification : {};
  const category = isRecord(classification.category) ? classification.category : null;
  const currentTags = Array.isArray(classification.processTags)
    ? classification.processTags.filter(isRecord)
    : [];
  const [categoryId, setCategoryId] = useState(text(category?.id, ""));
  const [tagIds, setTagIds] = useState<string[]>(currentTags.map((tag) => text(tag.id, "")));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const resourceVersion = Number(drawing.resourceVersion ?? drawing.version ?? 1);

  const submit = async () => {
    if (!categoryId || !reason.trim()) return;
    setBusy(true);
    try {
      await onCommand({
        path: encodeProjectPath(
          projectId,
          `/drawings/${encodeURIComponent(id(drawing.id, ""))}/classification`
        ),
        method: "PUT",
        body: { categoryId, processTagIds: tagIds, version: resourceVersion, reason }
      });
      setReason("");
      onCompleted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="drawing-classification-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label>
        制造分类
        <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
          <option value="">请选择</option>
          {categories.map((entry) => (
            <option key={text(entry.id)} value={text(entry.id)}>
              {text(entry.name, text(entry.code))}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>工艺标签</legend>
        <div className="drawing-tag-options">
          {processTags.map((entry) => {
            const tagId = text(entry.id);
            return (
              <label key={tagId}>
                <input
                  type="checkbox"
                  checked={tagIds.includes(tagId)}
                  onChange={(event) =>
                    setTagIds((current) =>
                      event.target.checked
                        ? [...current, tagId]
                        : current.filter((value) => value !== tagId)
                    )
                  }
                />
                {text(entry.name, text(entry.code))}
              </label>
            );
          })}
        </div>
      </fieldset>
      <label>
        变更原因
        <input value={reason} onChange={(event) => setReason(event.target.value)} required />
      </label>
      <button className="drawing-command" type="submit" disabled={busy || !categoryId}>
        {busy ? "保存中" : "保存分类"}
      </button>
    </form>
  );
}

function DrawingList({
  projectId,
  state,
  onCommand,
  onReload
}: {
  projectId: string;
  state: Extract<DrawingWorkspacePageState, { status: "ready" | "empty" }>;
  onCommand: (input: CommandInput) => Promise<void>;
  onReload: () => void;
}) {
  const categoryState = state.categories;
  const processTagState = state.processTags;
  return (
    <section
      className="drawing-workspace-section drawing-classification-list"
      aria-labelledby="drawing-classification-title"
    >
      <div className="drawing-section-heading">
        <div>
          <p className="drawing-section-kicker">CONTROLLED DOCUMENTS</p>
          <h2 id="drawing-classification-title">图纸分类</h2>
        </div>
        <span>{state.drawings.length} 张</span>
      </div>
      {categoryState.status !== "ready" ? (
        <AreaNotice label="制造分类配置" state={categoryState} />
      ) : processTagState.status !== "ready" ? (
        <AreaNotice label="工艺标签配置" state={processTagState} />
      ) : null}
      {state.drawings.length === 0 ? (
        <p className="drawing-empty-inline">暂无可读取的项目图纸。</p>
      ) : (
        <div className="drawing-table-wrap">
          <table className="drawing-table">
            <thead>
              <tr>
                <th>图号</th>
                <th>图纸类型</th>
                <th>制造分类</th>
                <th>当前版本</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {state.drawings.map((drawing, index) => {
                const category =
                  isRecord(drawing.classification) && isRecord(drawing.classification.category)
                    ? drawing.classification.category
                    : null;
                return (
                  <tr key={id(drawing.id, `drawing-${index}`)}>
                    <th scope="row">{text(drawing.drawingNumber, `图纸 ${index + 1}`)}</th>
                    <td>{text(drawing.drawingType)}</td>
                    <td>{text(category?.code, "未分类")}</td>
                    <td>{text(drawing.version, text(drawing.resourceVersion))}</td>
                    <td>
                      {categoryState.status === "ready" &&
                      processTagState.status === "ready" &&
                      allowedActions(drawing.allowedActions).includes("UPDATE_CLASSIFICATION") ? (
                        <ClassificationForm
                          projectId={projectId}
                          drawing={drawing}
                          categories={categoryState.records}
                          processTags={processTagState.records}
                          onCommand={onCommand}
                          onCompleted={onReload}
                        />
                      ) : (
                        <span className="drawing-muted">当前状态或权限不允许编辑分类</span>
                      )}
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

function SelectionSets({
  projectId,
  state,
  onCommand,
  onReload
}: {
  projectId: string;
  state: Extract<DrawingWorkspacePageState, { status: "ready" | "empty" }>;
  onCommand: (input: CommandInput) => Promise<void>;
  onReload: () => void;
}) {
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedSetId, setSelectedSetId] = useState("");
  const [drawingId, setDrawingId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [spareQuantity, setSpareQuantity] = useState("0");
  const [requiredOn, setRequiredOn] = useState("");
  const [purpose, setPurpose] = useState("INQUIRY");
  const [itemReason, setItemReason] = useState("");
  const [supplierReferenceId, setSupplierReferenceId] = useState("");
  const [exceptionReason, setExceptionReason] = useState("");
  const [supplierMatches, setSupplierMatches] = useState<
    | { status: "idle" | "loading" | "restricted" }
    | { status: "error"; retryable: boolean }
    | { status: "ready"; records: readonly Record<string, unknown>[] }
  >({ status: "idle" });
  const [exceptionSuppliers, setExceptionSuppliers] = useState<
    | { status: "idle" | "loading" | "restricted" }
    | { status: "error"; retryable: boolean }
    | { status: "ready"; records: readonly Record<string, unknown>[] }
  >({ status: "idle" });
  const sets = state.selectionSets;
  const draftSets = sets.filter((selection) => selection.status === "DRAFT");
  const canCreateSelection = state.selectionActions.includes("CREATE_SELECTION");
  const selectableDrawings = state.drawings.filter((drawing) => {
    const document = isRecord(drawing.document) ? drawing.document : null;
    return (
      typeof drawing.id === "string" && typeof document?.currentPublishedVersionId === "string"
    );
  });
  const selectedDrawing = useMemo(
    () => selectableDrawings.find((candidate) => candidate.id === drawingId) ?? null,
    [drawingId, selectableDrawings]
  );
  const supplierMatchPath = useMemo(
    () => supplierMatchPathForDrawing(projectId, selectedDrawing),
    [projectId, selectedDrawing]
  );
  const visibleSupplierMatches =
    drawingId && state.supplierMatchesRequested && state.suppliers.status === "ready"
      ? { status: "ready" as const, records: state.suppliers.records }
      : supplierMatches;
  const defaultSupplierIds =
    visibleSupplierMatches.status === "ready"
      ? new Set(
          visibleSupplierMatches.records.map((supplier) => id(supplier.supplierReferenceId, ""))
        )
      : new Set<string>();
  const selectedSupplierIsException =
    Boolean(supplierReferenceId) && !defaultSupplierIds.has(supplierReferenceId);

  useEffect(() => {
    let active = true;
    if (!supplierMatchPath) {
      return () => {
        active = false;
      };
    }
    if (state.supplierMatchesRequested) {
      return () => {
        active = false;
      };
    }
    void Promise.all([
      fetchWorkspaceSource(supplierMatchPath),
      fetchWorkspaceSource(encodeProjectPath(projectId, "/procurement/suppliers?limit=100"))
    ]).then(([matchResult, suppliersResult]) => {
      if (!active) return;
      const toSupplierState = (
        result: Awaited<ReturnType<typeof fetchWorkspaceSource>>,
        key: string
      ) =>
        result.kind === "denied"
          ? ({ status: "restricted" } as const)
          : result.kind === "error"
            ? ({ status: "error", retryable: result.retryable } as const)
            : result.kind === "ok"
              ? ({ status: "ready", records: records(result.body, key) } as const)
              : ({ status: "loading" } as const);
      const nextMatchState = toSupplierState(matchResult, "matches");
      setSupplierMatches(nextMatchState);
      setExceptionSuppliers(toSupplierState(suppliersResult, "suppliers"));
      if (nextMatchState.status === "ready") {
        setSupplierReferenceId(id(nextMatchState.records[0]?.supplierReferenceId, ""));
      }
    });
    return () => {
      active = false;
    };
  }, [projectId, state.supplierMatchesRequested, state.suppliers, supplierMatchPath]);

  const createSet = async () => {
    if (!code.trim() || !title.trim() || !reason.trim()) return;
    setBusy(true);
    try {
      await onCommand({
        path: encodeProjectPath(projectId, "/drawing-selections"),
        method: "POST",
        body: { code, title, reason }
      });
      setCode("");
      setTitle("");
      setReason("");
      onReload();
    } finally {
      setBusy(false);
    }
  };

  const addItem = async () => {
    const selectedSet = draftSets.find(
      (selection) => id(selection.selectionSetId ?? selection.id, "") === selectedSetId
    );
    const drawing = selectedDrawing;
    const document = drawing && isRecord(drawing.document) ? drawing.document : null;
    const documentVersionId =
      typeof document?.currentPublishedVersionId === "string"
        ? document.currentPublishedVersionId
        : null;
    const supplierReady = visibleSupplierMatches.status === "ready";
    const requiresSupplier =
      visibleSupplierMatches.status === "ready" && visibleSupplierMatches.records.length > 0;
    if (
      !selectedSet ||
      !drawing ||
      !documentVersionId ||
      !requiredOn ||
      !itemReason.trim() ||
      !supplierReady ||
      (requiresSupplier && !supplierReferenceId) ||
      (selectedSupplierIsException && !exceptionReason.trim())
    )
      return;
    setBusy(true);
    try {
      await onCommand({
        path: encodeProjectPath(
          projectId,
          `/drawing-selections/${encodeURIComponent(selectedSetId)}/items`
        ),
        method: "POST",
        body: {
          drawingId,
          documentVersionId,
          quantity: Number(quantity),
          spareQuantity: Number(spareQuantity),
          requiredOn,
          supplierReferenceId: supplierReferenceId || null,
          purpose,
          exceptionReason: selectedSupplierIsException ? exceptionReason : null,
          version: Number(selectedSet.version ?? selectedSet.resourceVersion ?? 1),
          reason: itemReason
        }
      });
      setDrawingId("");
      setItemReason("");
      setSupplierReferenceId("");
      setExceptionReason("");
      onReload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="drawing-workspace-section" aria-labelledby="drawing-selection-title">
      <div className="drawing-section-heading">
        <div>
          <p className="drawing-section-kicker">INTERNAL PREPARATION</p>
          <h2 id="drawing-selection-title">选图分包</h2>
        </div>
        <span>{sets.length} 个</span>
      </div>
      {canCreateSelection ? (
        <form
          className="drawing-selection-create"
          onSubmit={(event) => {
            event.preventDefault();
            void createSet();
          }}
        >
          <label>
            分包代码
            <input value={code} onChange={(event) => setCode(event.target.value)} required />
          </label>
          <label>
            分包标题
            <input value={title} onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label>
            创建原因
            <input value={reason} onChange={(event) => setReason(event.target.value)} required />
          </label>
          <button className="drawing-command" type="submit" disabled={busy}>
            {busy ? "创建中" : "创建草稿分包"}
          </button>
        </form>
      ) : (
        <p className="drawing-muted">当前身份无权创建选图分包。</p>
      )}
      {sets.length === 0 ? (
        <p className="drawing-empty-inline">暂无选图分包。创建后只能在内部使用。</p>
      ) : (
        <ul className="drawing-selection-list">
          {sets.map((selection, index) => {
            const setId = id(selection.selectionSetId ?? selection.id, `selection-${index}`);
            const status = text(selection.status);
            const version = Number(selection.version ?? selection.resourceVersion ?? 1);
            const itemCount = Number(
              selection.itemCount ?? (Array.isArray(selection.items) ? selection.items.length : 0)
            );
            return (
              <li key={setId}>
                <div>
                  <strong>{text(selection.code, setId)}</strong>
                  <span>
                    {text(selection.title)} · {status} · {itemCount} 项
                  </span>
                </div>
                <div className="drawing-selection-actions">
                  {status === "DRAFT" &&
                  allowedActions(selection.allowedActions).includes("LOCK") ? (
                    <button
                      type="button"
                      className="drawing-command drawing-command-secondary"
                      onClick={() => {
                        setSelectedSetId(setId);
                        void onCommand({
                          path: encodeProjectPath(
                            projectId,
                            `/drawing-selections/${encodeURIComponent(setId)}/lock`
                          ),
                          method: "POST",
                          body: { version, reason: "完成内部选图复核并锁定" }
                        })
                          .then(onReload)
                          .catch(() => undefined);
                      }}
                    >
                      锁定分包
                    </button>
                  ) : null}
                  {selectedSetId === setId ? <small>正在更新…</small> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {draftSets.length > 0 && canCreateSelection ? (
        <form
          className="drawing-selection-item-form"
          onSubmit={(event) => {
            event.preventDefault();
            void addItem();
          }}
        >
          <h3>加入已发布图纸版本</h3>
          <p>系统只会提交图纸当前已发布的精确受控版本；供应商匹配和例外处置由服务端校验。</p>
          <label>
            草稿分包
            <select
              value={selectedSetId}
              onChange={(event) => setSelectedSetId(event.target.value)}
              required
            >
              <option value="">请选择</option>
              {draftSets.map((selection, index) => {
                const setId = id(selection.selectionSetId ?? selection.id, `selection-${index}`);
                return (
                  <option key={setId} value={setId}>
                    {text(selection.code, setId)}
                  </option>
                );
              })}
            </select>
          </label>
          <div className="drawing-supplier-match-list" aria-live="polite">
            <h4>供应商能力匹配</h4>
            {!drawingId ? (
              <p className="drawing-muted">
                选择已发布图纸后，系统才读取该图纸分类对应的默认匹配。
              </p>
            ) : visibleSupplierMatches.status === "loading" ? (
              <p className="drawing-muted">正在读取默认匹配供应商…</p>
            ) : visibleSupplierMatches.status === "restricted" ? (
              <p className="drawing-area-notice">供应商能力受限，服务端未授权显示其内容。</p>
            ) : visibleSupplierMatches.status === "error" ? (
              <p className="drawing-area-notice">供应商能力匹配暂不可用。</p>
            ) : visibleSupplierMatches.status === "ready" &&
              visibleSupplierMatches.records.length === 0 ? (
              <p className="drawing-empty-inline">
                无匹配供应商；可不指定供应商，后续由服务端保留 NO_MATCH 事实。
              </p>
            ) : visibleSupplierMatches.status === "ready" ? (
              <p className="drawing-muted">
                已找到 {visibleSupplierMatches.records.length} 个默认匹配供应商。
              </p>
            ) : null}
            {visibleSupplierMatches.status === "ready" ? (
              <label>
                供应商
                <select
                  value={supplierReferenceId}
                  onChange={(event) => setSupplierReferenceId(event.target.value)}
                  required={visibleSupplierMatches.records.length > 0}
                >
                  <option value="">
                    {visibleSupplierMatches.records.length === 0
                      ? "无匹配时不指定供应商"
                      : "请选择默认匹配供应商"}
                  </option>
                  {visibleSupplierMatches.records.map((supplier, index) => {
                    const supplierId = id(supplier.supplierReferenceId, `supplier-match-${index}`);
                    return (
                      <option key={supplierId} value={supplierId}>
                        {text(supplier.supplierName, text(supplier.supplierCode))}（默认匹配）
                      </option>
                    );
                  })}
                  {exceptionSuppliers.status === "ready" ? (
                    <optgroup label="例外供应商（需要填写原因）">
                      {exceptionSuppliers.records
                        .filter((supplier) => !defaultSupplierIds.has(id(supplier.id, "")))
                        .map((supplier, index) => {
                          const supplierId = id(supplier.id, `supplier-exception-${index}`);
                          return (
                            <option key={supplierId} value={supplierId}>
                              {text(supplier.name, text(supplier.code))}（例外）
                            </option>
                          );
                        })}
                    </optgroup>
                  ) : null}
                </select>
              </label>
            ) : null}
            {selectedSupplierIsException ? (
              <label>
                例外选择原因
                <input
                  value={exceptionReason}
                  onChange={(event) => setExceptionReason(event.target.value)}
                  required
                />
              </label>
            ) : null}
          </div>
          <label>
            已发布图纸
            <select
              value={drawingId}
              onChange={(event) => {
                const nextDrawingId = event.target.value;
                const nextDrawing =
                  selectableDrawings.find((candidate) => candidate.id === nextDrawingId) ?? null;
                const nextPath = supplierMatchPathForDrawing(projectId, nextDrawing);
                setDrawingId(nextDrawingId);
                setSupplierReferenceId("");
                setExceptionReason("");
                if (state.supplierMatchesRequested && state.suppliers.status === "ready") {
                  setSupplierMatches({ status: "ready", records: state.suppliers.records });
                  setSupplierReferenceId(id(state.suppliers.records[0]?.supplierReferenceId, ""));
                } else {
                  setSupplierMatches({ status: nextPath ? "loading" : "idle" });
                }
                setExceptionSuppliers({ status: nextPath ? "loading" : "idle" });
              }}
              required
            >
              <option value="">请选择</option>
              {selectableDrawings.map((drawing, index) => (
                <option key={id(drawing.id, `drawing-${index}`)} value={id(drawing.id, "")}>
                  {text(drawing.drawingNumber, `图纸 ${index + 1}`)} · 当前已发布版本
                </option>
              ))}
            </select>
          </label>
          <label>
            数量
            <input
              type="number"
              min="0.000001"
              step="0.000001"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              required
            />
          </label>
          <label>
            备件数量
            <input
              type="number"
              min="0"
              step="0.000001"
              value={spareQuantity}
              onChange={(event) => setSpareQuantity(event.target.value)}
              required
            />
          </label>
          <label>
            需求日期
            <input
              type="date"
              value={requiredOn}
              onChange={(event) => setRequiredOn(event.target.value)}
              required
            />
          </label>
          <label>
            用途
            <select value={purpose} onChange={(event) => setPurpose(event.target.value)}>
              <option value="INQUIRY">询价</option>
              <option value="MANUFACTURING">制造</option>
              <option value="CHANGE">变更</option>
              <option value="REFERENCE">参考</option>
            </select>
          </label>
          <label>
            加入原因
            <input
              value={itemReason}
              onChange={(event) => setItemReason(event.target.value)}
              required
            />
          </label>
          <button
            className="drawing-command"
            type="submit"
            disabled={
              busy ||
              selectableDrawings.length === 0 ||
              visibleSupplierMatches.status !== "ready" ||
              (visibleSupplierMatches.status === "ready" &&
                visibleSupplierMatches.records.length > 0 &&
                !supplierReferenceId) ||
              (selectedSupplierIsException && !exceptionReason.trim())
            }
          >
            {busy ? "加入中" : "加入精确图纸版本"}
          </button>
        </form>
      ) : null}
    </section>
  );
}

function SupplierMatchPanel({
  state
}: {
  state: Extract<DrawingWorkspacePageState, { status: "ready" | "empty" }>;
}) {
  return (
    <section
      className="drawing-workspace-section drawing-supplier-match-list"
      aria-labelledby="drawing-supplier-title"
    >
      <div className="drawing-section-heading">
        <div>
          <p className="drawing-section-kicker">PROJECT PROCUREMENT</p>
          <h2 id="drawing-supplier-title">供应商能力匹配</h2>
        </div>
      </div>
      {!state.supplierMatchesRequested ? (
        <p className="drawing-muted">选择已发布图纸后，系统按其制造分类和工艺标签读取默认匹配。</p>
      ) : state.suppliers.status === "restricted" || state.suppliers.status === "error" ? (
        <AreaNotice label="供应商能力" state={state.suppliers} />
      ) : state.suppliers.records.length === 0 ? (
        <p className="drawing-empty-inline">无匹配供应商</p>
      ) : (
        <ul className="drawing-supplier-list">
          {state.suppliers.records.map((supplier, index) => (
            <li key={id(supplier.supplierReferenceId ?? supplier.id, `supplier-${index}`)}>
              <strong>{text(supplier.supplierName, text(supplier.supplierCode))}</strong>
              <span>{text(supplier.categoryCode)} · 默认匹配</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DrawingWorkspaceContent({
  projectId,
  state,
  onRetry,
  onCommand,
  commandError
}: {
  projectId: string;
  state: DrawingWorkspacePageState;
  onRetry: () => void;
  onCommand?: (input: CommandInput) => Promise<void>;
  commandError?: string | null;
}) {
  if (state.status === "loading" || state.status === "denied" || state.status === "error") {
    return <StatePanel state={state} onRetry={onRetry} />;
  }
  const command = onCommand ?? (async () => undefined);
  return (
    <main className="drawing-workspace drawing-workspace-state" aria-label="项目图纸工作区">
      <header className="drawing-workspace-header">
        <div>
          <p className="drawing-eyebrow">DRAWING WORKSPACE</p>
          <h1>图纸分类与选图分包</h1>
          <p>仅引用当前项目已授权的受控图纸事实，分包只用于内部准备。</p>
        </div>
        <dl className="drawing-source-timestamps">
          <div>
            <dt>图纸读取</dt>
            <dd>{text(state.sourceFetchedAt.drawings, "尚无时间")}</dd>
          </div>
          <div>
            <dt>选图读取</dt>
            <dd>{text(state.sourceFetchedAt.selections, "尚无时间")}</dd>
          </div>
        </dl>
      </header>
      {state.stale ? (
        <p className="drawing-stale-banner" role="status">
          部分图纸数据已过期，请刷新确认后再提交命令。
        </p>
      ) : null}
      {commandError ? (
        <p className="drawing-command-error" role="alert">
          {commandError}
        </p>
      ) : null}
      {state.status === "empty" ? (
        <p className="drawing-empty-banner">暂无可操作的项目图纸或选图分包。</p>
      ) : null}
      <div className="drawing-workspace-grid">
        <DrawingList projectId={projectId} state={state} onCommand={command} onReload={onRetry} />
        <SupplierMatchPanel state={state} />
        <SelectionSets projectId={projectId} state={state} onCommand={command} onReload={onRetry} />
      </div>
    </main>
  );
}

export function DrawingWorkspaceClient({
  projectId,
  initialState,
  initialCommandError = null
}: DrawingWorkspaceClientProps) {
  const [state, setState] = useState<DrawingWorkspacePageState>(
    initialState ?? { projectId, status: "loading" }
  );
  const [commandError, setCommandError] = useState<string | null>(initialCommandError);

  const reload = useCallback(async () => {
    setState({ projectId, status: "loading" });
    setState(await loadDrawingWorkspaceState(projectId));
  }, [projectId]);

  const executeCommand = useCallback(async (input: CommandInput) => {
    setCommandError(null);
    const response = await fetch(input.path, {
      method: input.method,
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "idempotency-key": clientIdempotencyKey()
      },
      body: JSON.stringify(input.body)
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = commandMessage(response.status, body);
      setCommandError(message);
      throw new Error(message);
    }
  }, []);

  useEffect(() => {
    if (initialState) return;
    void loadDrawingWorkspaceState(projectId).then(setState);
  }, [initialState, projectId]);

  return (
    <DrawingWorkspaceContent
      projectId={projectId}
      state={state}
      onRetry={() => void reload()}
      onCommand={executeCommand}
      commandError={commandError}
    />
  );
}
