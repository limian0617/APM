export const GATE_APPROVAL_MODES = ["ALL", "ANY"] as const;
export type GateApprovalModeCode = (typeof GATE_APPROVAL_MODES)[number];

export const GATE_SUBMISSION_STATUSES = ["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"] as const;
export type GateSubmissionStatusCode = (typeof GATE_SUBMISSION_STATUSES)[number];

export const GATE_APPROVAL_DECISIONS = ["APPROVED", "REJECTED"] as const;
export type GateApprovalDecisionCode = (typeof GATE_APPROVAL_DECISIONS)[number];

export class GateSubmissionError extends Error {
  constructor(
    readonly code: "GATE_APPROVER_CONFIGURATION_INVALID" | "GATE_APPROVER_EMPTY",
    message: string
  ) {
    super(message);
    this.name = "GateSubmissionError";
  }
}

export type GateSubmissionApproverSnapshot = {
  userId: string;
  membershipIds: string[];
  projectRoles: string[];
};

export function resolveGateSubmissionApprovers(input: {
  approverProjectRoles: readonly string[];
  activeMembers: ReadonlyArray<{ membershipId: string; userId: string; projectRole: string }>;
}): GateSubmissionApproverSnapshot[] {
  const configuredRoles = [...new Set(input.approverProjectRoles.map((role) => role.trim()))]
    .filter(Boolean)
    .sort();
  if (configuredRoles.length === 0) {
    throw new GateSubmissionError(
      "GATE_APPROVER_CONFIGURATION_INVALID",
      "Gate 未配置审批项目角色。"
    );
  }

  const configuredRoleSet = new Set(configuredRoles);
  const snapshots = new Map<string, GateSubmissionApproverSnapshot>();
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
    throw new GateSubmissionError("GATE_APPROVER_EMPTY", "Gate 配置的审批角色没有有效项目成员。");
  }
  return resolved;
}

export function evaluateGateSubmissionDecision(input: {
  approvalMode: GateApprovalModeCode;
  approverUserIds: readonly string[];
  decisions: ReadonlyArray<{ userId: string; decision: GateApprovalDecisionCode }>;
}): Extract<GateSubmissionStatusCode, "PENDING" | "APPROVED" | "REJECTED"> {
  if (input.decisions.some(({ decision }) => decision === "REJECTED")) return "REJECTED";

  const approvedUsers = new Set(
    input.decisions.filter(({ decision }) => decision === "APPROVED").map(({ userId }) => userId)
  );
  if (input.approvalMode === "ANY") {
    return approvedUsers.size > 0 ? "APPROVED" : "PENDING";
  }
  return input.approverUserIds.every((userId) => approvedUsers.has(userId))
    ? "APPROVED"
    : "PENDING";
}
