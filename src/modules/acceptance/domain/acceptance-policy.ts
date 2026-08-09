import { createHash } from "node:crypto";

export const ACCEPTANCE_TYPES = ["FAT", "SAT"] as const;
export type AcceptanceType = (typeof ACCEPTANCE_TYPES)[number];

export const ACCEPTANCE_SCOPE_TYPES = ["PROJECT", "DELIVERY_UNIT", "MACHINE"] as const;
export type AcceptanceScopeType = (typeof ACCEPTANCE_SCOPE_TYPES)[number];

export const ACCEPTANCE_BATCH_STATUSES = ["DRAFT", "IN_PROGRESS", "LOCKED"] as const;
export type AcceptanceBatchStatus = (typeof ACCEPTANCE_BATCH_STATUSES)[number];

export const ACCEPTANCE_DECISIONS = ["PASS", "FAIL", "NA"] as const;
export type AcceptanceDecision = (typeof ACCEPTANCE_DECISIONS)[number];

export type AcceptanceTemplateItemSnapshot = Readonly<{
  code: string;
  name: string;
  position: number;
  method: string;
  acceptanceCriteria: string;
  unit: string | null;
  required: boolean;
  evidenceRequired: boolean;
  applicableScope: string;
  defaultDiscipline: string;
}>;

export type AcceptanceTemplateSnapshot = Readonly<{
  items: ReadonlyArray<AcceptanceTemplateItemSnapshot>;
}>;

export type AcceptanceTemplateContent = Readonly<{
  acceptanceType: AcceptanceType;
  items: ReadonlyArray<AcceptanceTemplateItemSnapshot>;
}>;

export class AcceptancePolicyError extends Error {
  readonly status: number;

  constructor(
    readonly code: string,
    message: string,
    status = 422
  ) {
    super(message);
    this.name = "AcceptancePolicyError";
    this.status = status;
  }
}

export function validateTemplateSnapshot(
  snapshot: AcceptanceTemplateSnapshot
): AcceptanceTemplateSnapshot {
  if (!Array.isArray(snapshot.items) || snapshot.items.length === 0) {
    throw new AcceptancePolicyError(
      "ACCEPTANCE_TEMPLATE_SNAPSHOT_INVALID",
      "验收模板版本必须包含至少一个测试项。"
    );
  }

  const codes = new Set<string>();
  const positions = new Set<number>();
  const items = snapshot.items.map((item) => {
    if (!item || typeof item !== "object") {
      throw new AcceptancePolicyError(
        "ACCEPTANCE_TEMPLATE_SNAPSHOT_INVALID",
        "验收模板测试项快照无效。"
      );
    }
    const code = textField(item.code, "code");
    const name = textField(item.name, "name");
    const method = textField(item.method, "method");
    const acceptanceCriteria = textField(item.acceptanceCriteria, "acceptanceCriteria");
    const applicableScope = textField(item.applicableScope, "applicableScope");
    const defaultDiscipline = textField(item.defaultDiscipline, "defaultDiscipline");
    if (!Number.isSafeInteger(item.position) || item.position < 1) {
      throw new AcceptancePolicyError(
        "ACCEPTANCE_TEMPLATE_SNAPSHOT_INVALID",
        "验收测试项 position 必须是正整数。"
      );
    }
    if (codes.has(code) || positions.has(item.position)) {
      throw new AcceptancePolicyError(
        "ACCEPTANCE_TEMPLATE_SNAPSHOT_INVALID",
        "验收模板测试项编码和顺序必须唯一。"
      );
    }
    if (typeof item.required !== "boolean" || typeof item.evidenceRequired !== "boolean") {
      throw new AcceptancePolicyError(
        "ACCEPTANCE_TEMPLATE_SNAPSHOT_INVALID",
        "验收测试项 required 和 evidenceRequired 必须是布尔值。"
      );
    }
    if (item.unit !== null && item.unit !== undefined && typeof item.unit !== "string") {
      throw new AcceptancePolicyError(
        "ACCEPTANCE_TEMPLATE_SNAPSHOT_INVALID",
        "验收测试项 unit 必须是文本或 null。"
      );
    }
    codes.add(code);
    positions.add(item.position);
    return {
      code,
      name,
      position: item.position,
      method,
      acceptanceCriteria,
      unit: item.unit?.trim() || null,
      required: item.required,
      evidenceRequired: item.evidenceRequired,
      applicableScope,
      defaultDiscipline
    };
  });

  return { items };
}

export function calculateAcceptanceTemplateChecksum(input: AcceptanceTemplateContent): string {
  if (!ACCEPTANCE_TYPES.includes(input.acceptanceType)) {
    throw new AcceptancePolicyError(
      "ACCEPTANCE_TEMPLATE_SNAPSHOT_INVALID",
      "验收模板类型必须为 FAT 或 SAT。"
    );
  }
  const normalized = normalizeTemplateItems(input.items);
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        acceptanceType: input.acceptanceType,
        items: normalized
      })
    )
    .digest("hex")}`;
}

export function assertMeasuredUnitMatchesFrozenDefinition(
  frozenUnit: string | null,
  suppliedUnit: string | null
): void {
  if (frozenUnit === null && suppliedUnit !== null) {
    throw new AcceptancePolicyError(
      "ACCEPTANCE_MEASURED_UNIT_NOT_ALLOWED",
      "未定义单位的测试项不能录入实测单位。"
    );
  }
  if (frozenUnit !== null && suppliedUnit !== frozenUnit) {
    throw new AcceptancePolicyError(
      "ACCEPTANCE_MEASURED_UNIT_MISMATCH",
      "实测单位必须与冻结测试项单位一致。"
    );
  }
}

export function assertRetestBatchCompatible(input: {
  projectId: string;
  acceptanceType: AcceptanceType;
  scopeType: AcceptanceScopeType;
  scopeId: string;
  original: {
    projectId: string;
    acceptanceType: AcceptanceType;
    scopeType: AcceptanceScopeType;
    scopeId: string;
    status: AcceptanceBatchStatus;
  } | null;
}): void {
  if (!input.original || input.original.projectId !== input.projectId) {
    throw new AcceptancePolicyError("ACCEPTANCE_RETEST_NOT_FOUND", "重测原批次不存在。", 404);
  }
  if (input.original.status !== "LOCKED") {
    throw new AcceptancePolicyError(
      "ACCEPTANCE_RETEST_ORIGINAL_NOT_LOCKED",
      "重测原批次必须已锁定。",
      409
    );
  }
  if (
    input.original.acceptanceType !== input.acceptanceType ||
    input.original.scopeType !== input.scopeType ||
    input.original.scopeId !== input.scopeId
  ) {
    throw new AcceptancePolicyError(
      "ACCEPTANCE_RETEST_SCOPE_MISMATCH",
      "重测批次必须与原批次使用相同验收类型和范围。"
    );
  }
}

export function assertScopeBelongsToProject(input: {
  projectId: string;
  scopeType: AcceptanceScopeType;
  scopeId: string;
  scope: { id: string; projectId: string } | null;
}): void {
  if (!input.scopeId.trim() || !input.scope || input.scope.id !== input.scopeId) {
    throw new AcceptancePolicyError("ACCEPTANCE_SCOPE_NOT_FOUND", "验收范围不存在。", 404);
  }
  if (input.scope.projectId !== input.projectId) {
    throw new AcceptancePolicyError(
      "ACCEPTANCE_SCOPE_PROJECT_MISMATCH",
      "验收范围不属于当前项目。",
      404
    );
  }
  if (input.scopeType === "PROJECT" && input.scope.id !== input.projectId) {
    throw new AcceptancePolicyError("ACCEPTANCE_SCOPE_PROJECT_MISMATCH", "项目验收范围无效。", 422);
  }
}

export function assertBatchCanTransition(
  from: AcceptanceBatchStatus,
  to: AcceptanceBatchStatus
): AcceptanceBatchStatus {
  if (from === "DRAFT" && to === "IN_PROGRESS") return to;
  if (from === "IN_PROGRESS" && to === "LOCKED") return to;
  if (from === to) {
    throw new AcceptancePolicyError(
      "ACCEPTANCE_BATCH_STATE_UNCHANGED",
      "验收批次状态未发生变化.",
      409
    );
  }
  if (from === "LOCKED") {
    throw new AcceptancePolicyError(
      "ACCEPTANCE_BATCH_LOCKED",
      "已锁定的验收批次不可重新打开。",
      409
    );
  }
  throw new AcceptancePolicyError("ACCEPTANCE_BATCH_STATE_INVALID", "验收批次状态转换无效。", 409);
}

export function assertBatchMutable(status: AcceptanceBatchStatus): void {
  if (status === "LOCKED") {
    throw new AcceptancePolicyError("ACCEPTANCE_BATCH_LOCKED", "验收批次已锁定，不可修改。", 409);
  }
}

export function assertRequiredEvidencePresent(
  items: ReadonlyArray<{
    evidenceRequired: boolean;
    decision: AcceptanceDecision | null;
    evidenceCount: number;
  }>
): void {
  if (
    items.some(
      (item) =>
        item.evidenceRequired &&
        item.decision !== null &&
        (!Number.isInteger(item.evidenceCount) || item.evidenceCount < 1)
    )
  ) {
    throw new AcceptancePolicyError(
      "ACCEPTANCE_EVIDENCE_REQUIRED",
      "必测证据尚未引用已扫描且可用的文件。",
      409
    );
  }
}

export const assertResultMutable = assertBatchMutable;

export type AcceptanceSummary = Readonly<{
  passCount: number;
  failCount: number;
  naCount: number;
  unexecutedRequiredCount: number;
  denominator: number;
  passRate: number | null;
  outcome: "PASS" | "FAILED" | "PENDING" | "NOT_CALCULABLE";
}>;

export function calculateAcceptanceSummary(
  items: ReadonlyArray<{ required: boolean; decision: AcceptanceDecision | null }>
): AcceptanceSummary {
  const passCount = items.filter((item) => item.decision === "PASS").length;
  const failCount = items.filter((item) => item.decision === "FAIL").length;
  const naCount = items.filter((item) => item.decision === "NA").length;
  const unexecutedRequiredCount = items.filter(
    (item) => item.required && item.decision === null
  ).length;
  const denominator = passCount + failCount;
  const passRate = denominator === 0 ? null : passCount / denominator;
  const outcome =
    unexecutedRequiredCount > 0
      ? "PENDING"
      : failCount > 0
        ? "FAILED"
        : denominator === 0
          ? "NOT_CALCULABLE"
          : "PASS";
  return {
    passCount,
    failCount,
    naCount,
    unexecutedRequiredCount,
    denominator,
    passRate,
    outcome
  };
}

export function validateMeasuredValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new AcceptancePolicyError(
      "ACCEPTANCE_MEASURED_VALUE_INVALID",
      "measuredValue 必须是文本或 null。"
    );
  }
  const normalized = value.trim();
  if (normalized.length > 2000) {
    throw new AcceptancePolicyError(
      "ACCEPTANCE_MEASURED_VALUE_INVALID",
      "measuredValue 不能超过 2000 个字符。"
    );
  }
  return normalized || null;
}

function textField(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AcceptancePolicyError(
      "ACCEPTANCE_TEMPLATE_SNAPSHOT_INVALID",
      `验收测试项 ${field} 必须是非空文本。`
    );
  }
  return value.trim();
}

function normalizeTemplateItems(
  items: ReadonlyArray<AcceptanceTemplateItemSnapshot>
): ReadonlyArray<AcceptanceTemplateItemSnapshot> {
  return validateTemplateSnapshot({ items })
    .items.slice()
    .sort((left, right) => left.position - right.position || left.code.localeCompare(right.code));
}

export function normalizeAcceptanceEvidenceFileIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new AcceptancePolicyError(
      "ACCEPTANCE_EVIDENCE_INVALID",
      "evidenceFileIds 必须是文件标识数组。"
    );
  }
  const ids = value.map((fileId) => {
    if (typeof fileId !== "string" || !fileId.trim() || fileId.trim().length > 191) {
      throw new AcceptancePolicyError("ACCEPTANCE_EVIDENCE_INVALID", "证据文件标识无效。");
    }
    return fileId.trim();
  });
  if (new Set(ids).size !== ids.length) {
    throw new AcceptancePolicyError(
      "ACCEPTANCE_EVIDENCE_DUPLICATE",
      "同一结果修订不能重复引用证据文件。"
    );
  }
  return ids;
}
