export const RESIDUAL_ITEM_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "AWAITING_VERIFICATION",
  "CLOSED"
] as const;

export type ResidualItemStatus = (typeof RESIDUAL_ITEM_STATUSES)[number];

export const RESIDUAL_ITEM_ACTIONS = ["START", "SUBMIT_VERIFICATION", "VERIFY", "RETURN"] as const;

export type ResidualItemAction = (typeof RESIDUAL_ITEM_ACTIONS)[number];

export type ResidualItemInput = {
  title: string;
  ownerMembershipId: string;
  verifierMembershipId: string;
  dueAt: Date;
  evidence: string;
  escalationRule: string;
};

export class GateConditionalReleaseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = "GateConditionalReleaseError";
  }
}

function requiredText(value: unknown, code: string, label: string, maximumLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximumLength) {
    throw new GateConditionalReleaseError(
      code,
      `${label}必须是 1 到 ${maximumLength} 个字符。`,
      422
    );
  }
  return value.trim();
}

export function validateResidualItemInput(input: ResidualItemInput): ResidualItemInput {
  const title = requiredText(input.title, "RESIDUAL_TITLE_REQUIRED", "遗留项标题", 191);
  const ownerMembershipId = requiredText(
    input.ownerMembershipId,
    "RESIDUAL_OWNER_REQUIRED",
    "遗留项 Owner",
    191
  );
  const verifierMembershipId = requiredText(
    input.verifierMembershipId,
    "RESIDUAL_VERIFIER_REQUIRED",
    "遗留项验证人",
    191
  );
  if (!(input.dueAt instanceof Date) || Number.isNaN(input.dueAt.getTime())) {
    throw new GateConditionalReleaseError(
      "RESIDUAL_DUE_AT_REQUIRED",
      "遗留项截止日必须是有效时间。",
      422
    );
  }
  const evidence = requiredText(input.evidence, "RESIDUAL_EVIDENCE_REQUIRED", "遗留项证据", 4096);
  const escalationRule = requiredText(
    input.escalationRule,
    "RESIDUAL_ESCALATION_REQUIRED",
    "遗留项升级规则",
    1024
  );
  return {
    title,
    ownerMembershipId,
    verifierMembershipId,
    dueAt: input.dueAt,
    evidence,
    escalationRule
  };
}

export function nextResidualStatus(
  current: ResidualItemStatus,
  action: ResidualItemAction
): ResidualItemStatus {
  if (current === "OPEN" && action === "START") return "IN_PROGRESS";
  if ((current === "OPEN" || current === "IN_PROGRESS") && action === "SUBMIT_VERIFICATION") {
    return "AWAITING_VERIFICATION";
  }
  if (current === "AWAITING_VERIFICATION" && action === "VERIFY") return "CLOSED";
  if (current === "AWAITING_VERIFICATION" && action === "RETURN") return "IN_PROGRESS";
  throw new GateConditionalReleaseError(
    "RESIDUAL_TRANSITION_INVALID",
    "遗留项当前状态不允许该操作。"
  );
}

export function validateConditionalReleaseEligibility(input: {
  submissionStatus: string;
  hasHardFailedCheck: boolean;
  actorIsFrozenApprover: boolean;
  actorIsActiveProjectMember: boolean;
  targetStageStatus: string;
}) {
  if (input.submissionStatus !== "APPROVED") {
    throw new GateConditionalReleaseError(
      "GATE_CONDITIONAL_RELEASE_NOT_APPROVED",
      "Conditional release requires an approved Gate submission."
    );
  }
  if (input.hasHardFailedCheck) {
    throw new GateConditionalReleaseError(
      "GATE_CONDITIONAL_RELEASE_HARD_FAILED",
      "Conditional release cannot use a Gate submission with hard failures."
    );
  }
  if (!input.actorIsFrozenApprover || !input.actorIsActiveProjectMember) {
    throw new GateConditionalReleaseError(
      "GATE_CONDITIONAL_RELEASE_FORBIDDEN",
      "Only an active frozen Gate approver can conditionally release this Gate.",
      403
    );
  }
  if (input.targetStageStatus !== "AWAITING_GATE") {
    throw new GateConditionalReleaseError(
      "GATE_CONDITIONAL_RELEASE_STAGE_INVALID",
      "Conditional release target stage must await Gate."
    );
  }
}
