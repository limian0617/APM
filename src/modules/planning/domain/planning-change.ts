import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";

export class PlanningChangeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = "PlanningChangeError";
  }
}

/**
 * 变更分类。判定规则由业务 Owner 以策略形式提供，领域只执行策略结果。
 * - FORECAST_ONLY：普通延期，只更新当前预测，不改基线。
 * - FORMAL：正式范围或合同交期变更，可以生成基线 V2，V1 永久保留。
 */
export const PLANNING_CHANGE_CLASSIFICATIONS = ["FORECAST_ONLY", "FORMAL"] as const;
export type PlanningChangeClassification = (typeof PLANNING_CHANGE_CLASSIFICATIONS)[number];

export const PLANNING_CHANGE_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"] as const;
export type PlanningChangeStatusCode = (typeof PLANNING_CHANGE_STATUSES)[number];

export const PLANNING_CHANGE_APPROVAL_MODES = ["ALL", "ANY"] as const;
export type PlanningChangeApprovalMode = (typeof PLANNING_CHANGE_APPROVAL_MODES)[number];

export const PLANNING_CHANGE_APPROVAL_DECISIONS = ["APPROVED", "REJECTED"] as const;
export type PlanningChangeApprovalDecision = (typeof PLANNING_CHANGE_APPROVAL_DECISIONS)[number];

/**
 * 分类策略。审批人解析规则、普通延期与正式变更的判定边界尚未由业务 Owner 确认，
 * 因此以端口形式注入；本工作包只提供默认策略与显式声明，不自行编造业务阈值。
 */
export type PlanningChangeClassificationPolicy = {
  readonly code: string;
  readonly version: number;
  /**
   * 返回声明的变更分类；返回未声明（NOT_DECLARED）表示不由本策略判定，
   * 调用方必须显式提供分类，不能默认升级为正式变更。
   */
  classify: (input: {
    readonly declaredClassification: PlanningChangeClassification | null;
    readonly affectsContractScope: boolean;
    readonly affectsContractDelivery: boolean;
  }) => PlanningChangeClassification | "NOT_DECLARED";
};

export const DEFAULT_PLANNING_CHANGE_CLASSIFICATION_POLICY: PlanningChangeClassificationPolicy = {
  code: "PLANNING.CHANGE.CLASSIFICATION@1",
  version: 1,
  classify: ({ declaredClassification }) => declaredClassification ?? "NOT_DECLARED"
};

export type PlanningChangeApproverSnapshot = {
  userId: string;
  membershipIds: string[];
  projectRoles: string[];
};

/**
 * 按项目角色解析冻结审批人，语义与 Gate 提交一致（见 gate-submission.ts）。
 * 解析结果在提交时冻结为快照，之后成员变化不改写历史。
 */
export function resolvePlanningChangeApprovers(input: {
  approverProjectRoles: readonly string[];
  activeMembers: ReadonlyArray<{ membershipId: string; userId: string; projectRole: string }>;
}): PlanningChangeApproverSnapshot[] {
  const configuredRoles = [...new Set(input.approverProjectRoles.map((role) => role.trim()))]
    .filter(Boolean)
    .sort();
  if (configuredRoles.length === 0) {
    throw new PlanningChangeError(
      "PLANNING_CHANGE_APPROVER_CONFIGURATION_INVALID",
      "计划变更未配置审批项目角色。",
      422
    );
  }

  const configuredRoleSet = new Set(configuredRoles);
  const snapshots = new Map<string, PlanningChangeApproverSnapshot>();
  for (const member of input.activeMembers) {
    if (!configuredRoleSet.has(member.projectRole)) continue;
    const existing = snapshots.get(member.userId) ?? {
      userId: member.userId,
      membershipIds: [],
      projectRoles: []
    };
    existing.membershipIds.push(member.membershipId);
    existing.projectRoles.push(member.projectRole);
    snapshots.set(member.userId, existing);
  }

  const resolved = [...snapshots.values()]
    .map((snapshot) => ({
      ...snapshot,
      membershipIds: [...new Set(snapshot.membershipIds)].sort(),
      projectRoles: [...new Set(snapshot.projectRoles)].sort()
    }))
    .sort((left, right) => left.userId.localeCompare(right.userId));
  if (resolved.length === 0) {
    throw new PlanningChangeError(
      "PLANNING_CHANGE_APPROVER_EMPTY",
      "计划变更配置的审批角色没有有效项目成员。",
      422
    );
  }
  return resolved;
}

/**
 * ALL 会签：任一拒绝即拒绝，全部批准才批准。
 * ANY 或签：任一拒绝即拒绝，任一人批准即批准。
 */
export function evaluatePlanningChangeDecision(input: {
  approvalMode: PlanningChangeApprovalMode;
  approverUserIds: readonly string[];
  decisions: ReadonlyArray<{ userId: string; decision: PlanningChangeApprovalDecision }>;
}): Extract<PlanningChangeStatusCode, "SUBMITTED" | "APPROVED" | "REJECTED"> {
  if (input.decisions.some(({ decision }) => decision === "REJECTED")) return "REJECTED";

  const approvedUsers = new Set(
    input.decisions.filter(({ decision }) => decision === "APPROVED").map(({ userId }) => userId)
  );
  if (input.approvalMode === "ANY") {
    return approvedUsers.size > 0 ? "APPROVED" : "SUBMITTED";
  }
  return input.approverUserIds.every((userId) => approvedUsers.has(userId))
    ? "APPROVED"
    : "SUBMITTED";
}

/**
 * 已批准变更是否必须生成新基线。
 * FORECAST_ONLY 永远返回 null：普通延期只更新当前预测，不改基线。
 */
export function requiredBaselineVersion(classification: PlanningChangeClassification): null | 2 {
  if (classification === "FORECAST_ONLY") return null;
  return 2;
}

export type PlanningChangeRevisionInput = {
  revision: number;
  classification: PlanningChangeClassification;
  reason: string;
  planningInputVersion: number;
  /** 变更生效后的预测输入版本；普通延期在此推进，基线不动。 */
  resultingPlanningInputVersion: number;
  delta: JsonValue;
};

export type PlanningChangeRevisionSnapshot = PlanningChangeRevisionInput & {
  checksum: string;
};

function compareText(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

/**
 * 规范化变更差异载荷：按键排序递归输出，保证同一语义输入产生同一 checksum。
 */
export function canonicalizePlanningChangeDelta(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => canonicalizePlanningChangeDelta(entry));
  if (!isJsonRecord(value)) return value;
  const canonical: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value).sort(compareText)) {
    canonical[key] = canonicalizePlanningChangeDelta(value[key] as JsonValue);
  }
  return canonical;
}

export function buildPlanningChangeRevision(
  input: PlanningChangeRevisionInput
): PlanningChangeRevisionSnapshot {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new PlanningChangeError(
      "PLANNING_CHANGE_REVISION_INVALID",
      "变更修订号必须是正整数。",
      422
    );
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 1024) {
    throw new PlanningChangeError("REASON_REQUIRED", "操作原因必须是 1 到 1024 个字符。", 422);
  }
  if (
    !Number.isSafeInteger(input.planningInputVersion) ||
    input.planningInputVersion < 1 ||
    !Number.isSafeInteger(input.resultingPlanningInputVersion) ||
    input.resultingPlanningInputVersion < input.planningInputVersion
  ) {
    throw new PlanningChangeError(
      "PLANNING_CHANGE_INPUT_VERSION_INVALID",
      "计划输入版本必须为正整数，且变更后版本不得回退。",
      422
    );
  }
  if (!isJsonRecord(input.delta)) {
    throw new PlanningChangeError(
      "PLANNING_CHANGE_DELTA_INVALID",
      "变更差异必须是 JSON 对象。",
      422
    );
  }
  const canonicalDelta = canonicalizePlanningChangeDelta(input.delta);
  const checksum = payloadHash({
    revision: input.revision,
    classification: input.classification,
    planningInputVersion: input.planningInputVersion,
    resultingPlanningInputVersion: input.resultingPlanningInputVersion,
    delta: canonicalDelta
  }).hash;
  return {
    revision: input.revision,
    classification: input.classification,
    reason,
    planningInputVersion: input.planningInputVersion,
    resultingPlanningInputVersion: input.resultingPlanningInputVersion,
    delta: canonicalDelta,
    checksum
  };
}
